import http from 'node:http';
import zlib from 'node:zlib';

/**
 * Build an in-memory .tar.gz buffer using pure Node zlib (ustar format).
 */
export function buildTarGz(entries) {
  const blocks = [];
  for (const { name, content } of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, Math.min(100, Buffer.byteLength(name)), 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
    header.fill(0x20, 148, 156);
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');

    let checksum = 0;
    for (let i = 0; i < 512; i += 1) checksum += header[i];
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');

    blocks.push(header);
    if (data.length > 0) {
      const paddedLen = Math.ceil(data.length / 512) * 512;
      const padded = Buffer.alloc(paddedLen, 0);
      data.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/**
 * Ephemeral local HTTP mock npm registry bound to 127.0.0.1:0.
 *
 * packages: {
 *   [pkgName]: {
 *     latest: '1.0.0',
 *     versions: {
 *       '1.0.0': [{ name: 'package/plugin.json', content: '...' }, ...]
 *     }
 *   }
 * }
 */
export async function startMockNpmRegistry({ packages = {}, failWithStatus = null } = {}) {
  const pkgMap = new Map(Object.entries(packages));
  let currentFailStatus = failWithStatus;
  const requests = [];

  let baseUrl = '';

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url || '/', baseUrl || 'http://127.0.0.1');
    requests.push({ method: req.method, pathname: reqUrl.pathname });

    if (currentFailStatus) {
      res.writeHead(currentFailStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Simulated registry failure HTTP ${currentFailStatus}` }));
      return;
    }

    const tarballPrefix = '/-/tarball/';
    if (reqUrl.pathname.startsWith(tarballPrefix)) {
      const rest = decodeURIComponent(reqUrl.pathname.slice(tarballPrefix.length));
      const lastSlash = rest.lastIndexOf('/');
      if (lastSlash === -1) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const pkgName = rest.slice(0, lastSlash);
      const versionWithExt = rest.slice(lastSlash + 1);
      const version = versionWithExt.replace(/\.tgz$/, '');
      const pkg = pkgMap.get(pkgName);
      const entries = pkg?.versions?.[version];
      if (!entries) {
        res.writeHead(404);
        res.end('Tarball not found');
        return;
      }
      const tgz = buildTarGz(entries);
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Length': String(tgz.length),
      });
      res.end(tgz);
      return;
    }

    const pkgName = decodeURIComponent(reqUrl.pathname.replace(/^\/+/, ''));
    const pkg = pkgMap.get(pkgName);
    if (!pkg) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Package "${pkgName}" not found` }));
      return;
    }

    const versionsDoc = {};
    const versionKeys = Object.keys(pkg.versions || {});
    for (const ver of versionKeys) {
      versionsDoc[ver] = {
        name: pkgName,
        version: ver,
        dist: {
          tarball: `${baseUrl}/-/tarball/${encodeURIComponent(pkgName)}/${encodeURIComponent(ver)}.tgz`,
        },
      };
    }

    const latest = pkg.latest || versionKeys[versionKeys.length - 1] || '1.0.0';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        name: pkgName,
        'dist-tags': { latest },
        versions: versionsDoc,
      }),
    );
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.address();
  baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    url: baseUrl,
    port: addr.port,
    requests,
    setFailStatus(status) {
      currentFailStatus = status;
    },
    setPackage(name, pkgDef) {
      pkgMap.set(name, pkgDef);
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
