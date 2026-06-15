import { describe, it, expect } from 'vitest'
import {
  isSocksGreeting,
  socksGreetingReply,
  socksConnectReply,
  parseSocksConnectRequest,
  SOCKS_REPLY,
} from '../socks'

function connectRequest(atyp: number, addr: number[], port: number): Buffer {
  return Buffer.from([5, 1, 0, atyp, ...addr, port >> 8, port & 0xff])
}

describe('isSocksGreeting', () => {
  it('accepts a SOCKS5 greeting', () => {
    expect(isSocksGreeting(Buffer.from([5, 1, 0]))).toBe(true)
  })

  it('rejects other versions and short packets', () => {
    expect(isSocksGreeting(Buffer.from([4, 1]))).toBe(false)
    expect(isSocksGreeting(Buffer.from([5]))).toBe(false)
  })
})

describe('socks replies', () => {
  it('negotiates no-auth', () => {
    expect([...socksGreetingReply()]).toEqual([5, 0])
  })

  it('builds a ten-byte connect reply with the given code', () => {
    const reply = socksConnectReply(SOCKS_REPLY.success)
    expect(reply.length).toBe(10)
    expect(reply[0]).toBe(5)
    expect(reply[1]).toBe(0)
  })
})

describe('parseSocksConnectRequest', () => {
  it('parses IPv4 addresses', () => {
    const result = parseSocksConnectRequest(connectRequest(1, [10, 0, 0, 5], 5432))
    expect(result).toEqual({ host: '10.0.0.5', port: 5432 })
  })

  it('parses domain names', () => {
    const domain = 'example.com'
    const result = parseSocksConnectRequest(
      connectRequest(3, [domain.length, ...Buffer.from(domain)], 443),
    )
    expect(result).toEqual({ host: 'example.com', port: 443 })
  })

  it('parses IPv6 addresses', () => {
    const addr = new Array(16).fill(0)
    addr[15] = 1
    const result = parseSocksConnectRequest(connectRequest(4, addr, 80))
    expect(result).toEqual({ host: '0:0:0:0:0:0:0:1', port: 80 })
  })

  it('rejects non-CONNECT commands', () => {
    const bind = Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 80])
    expect(parseSocksConnectRequest(bind)).toEqual({ errorCode: SOCKS_REPLY.commandNotSupported })
  })

  it('rejects unknown address types and truncated requests', () => {
    expect(parseSocksConnectRequest(Buffer.from([5, 1, 0, 9, 0, 0, 0]))).toEqual({
      errorCode: SOCKS_REPLY.addressTypeNotSupported,
    })
    expect(parseSocksConnectRequest(Buffer.from([5, 1, 0, 1, 127]))).toEqual({
      errorCode: SOCKS_REPLY.generalFailure,
    })
  })
})
