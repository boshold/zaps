/**
 * Node one-liner commands for integration tests.
 * These are sent to tmux panes as shell commands.
 */

export function httpServerCmd(port: number): string {
  return `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},()=>console.log('ready on port ${port}'))"`;
}

export function slowStartCmd(port: number, delayMs: number): string {
  return `node -e "setTimeout(()=>require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},()=>console.log('ready on port ${port}')),${delayMs})"`;
}

export function crashingCmd(port: number, crashAfterMs: number): string {
  return `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end('ok')}).listen(${port},()=>{console.log('ready on port ${port}');setTimeout(()=>process.exit(1),${crashAfterMs})})"`;
}

export function outputOnlyCmd(message: string, delayMs: number): string {
  return `node -e "setTimeout(()=>console.log('${message}'),${delayMs});setInterval(()=>{},60000)"`;
}
