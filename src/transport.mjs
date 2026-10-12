import net from 'node:net';
import { JsonPeer } from './protocol.mjs';

export async function listenAccess(service, { host = '127.0.0.1', port = 0, socketPath } = {}) {
  if (!socketPath && host !== '127.0.0.1') throw new Error('Prototype TCP endpoint must be loopback-only');
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    service.attach(new JsonPeer(socket));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath ?? { host, port }, resolve); });
  return {
    address: server.address(),
    async close() {
      await service.close(); for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
export async function connectAccess(endpoint) {
  const socket = net.createConnection(typeof endpoint === 'string' ? endpoint : { host: '127.0.0.1', port: endpoint.port });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return new JsonPeer(socket);
}
