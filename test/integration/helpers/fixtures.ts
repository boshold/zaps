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

export function httpHealthServerCmd(port: number, healthPath = "/health"): string {
  return `node -e "require('http').createServer((q,r)=>{if(q.url==='${healthPath}'){r.writeHead(200);r.end('ok')}else{r.writeHead(404);r.end()}}).listen(${port},()=>console.log('ready on port ${port}'))"`;
}

export function envEchoServerCmd(port: number, envVar: string): string {
  return `node -e "require('http').createServer((_,r)=>{r.writeHead(200);r.end(process.env['${envVar}']||'')}).listen(${port},()=>console.log('ready on port ${port}'))"`;
}

export function longRunningCmd(): string {
  return `node -e "setInterval(()=>{},60000)"`;
}
