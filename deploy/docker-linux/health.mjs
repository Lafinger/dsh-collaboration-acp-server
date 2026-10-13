import net from 'node:net';
const socket = net.createConnection('/run/collaboration/service.sock');
const timer = setTimeout(() => { socket.destroy(); process.exitCode = 1; }, 2000);
socket.once('connect', () => { clearTimeout(timer); socket.destroy(); });
socket.once('error', () => { clearTimeout(timer); process.exitCode = 1; });
