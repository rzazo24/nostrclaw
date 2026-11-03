// A relay that accepts the TCP connection but never answers the WebSocket handshake: nostr-tools gives up on it and closes the socket while it is
// still connecting. That used to throw an unhandled 'error' from ws and kill the server a few seconds after signer_connect.
import net from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { SimplePool } from 'nostr-tools/pool'
import '../src/signing/signer.js' // installs the WebSocket implementation nostr-tools uses

const sockets = new Set<net.Socket>()
const silent = net.createServer((s) => { sockets.add(s) }) // accept and say nothing
afterAll(() => new Promise<void>((r) => { for (const s of sockets) s.destroy(); silent.close(() => r()) }))

describe('a relay that never finishes the handshake', () => {
  it('times out without crashing the process', async () => {
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()))
    const port = (silent.address() as net.AddressInfo).port
    const pool = new SimplePool()
    await expect(pool.ensureRelay(`ws://127.0.0.1:${port}`, { connectionTimeout: 200 })).rejects.toBeDefined()
    await new Promise((r) => setTimeout(r, 300)) // the 'error' from closing a connecting socket arrives on a later tick
    pool.destroy()
  })
})
