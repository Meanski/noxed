// Minimal SOCKS5 request parsing for the dynamic-forward tunnel type.
// Only what a proxy client needs: no-auth negotiation and CONNECT requests.

export const SOCKS_VERSION = 5
export const SOCKS_CMD_CONNECT = 1

export const SOCKS_REPLY = {
  success: 0x00,
  generalFailure: 0x01,
  connectionRefused: 0x05,
  commandNotSupported: 0x07,
  addressTypeNotSupported: 0x08,
} as const

export interface SocksConnectRequest {
  host: string
  port: number
}

export function isSocksGreeting(data: Buffer): boolean {
  return data.length >= 2 && data[0] === SOCKS_VERSION
}

export function socksGreetingReply(): Buffer {
  // version 5, "no authentication required"
  return Buffer.from([SOCKS_VERSION, 0x00])
}

export function socksConnectReply(code: number): Buffer {
  // Reply with a zeroed IPv4 bind address — clients ignore it for CONNECT.
  return Buffer.from([SOCKS_VERSION, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}

export function parseSocksConnectRequest(data: Buffer): SocksConnectRequest | { errorCode: number } {
  if (data.length < 7 || data[0] !== SOCKS_VERSION) {
    return { errorCode: SOCKS_REPLY.generalFailure }
  }
  if (data[1] !== SOCKS_CMD_CONNECT) {
    return { errorCode: SOCKS_REPLY.commandNotSupported }
  }

  const addressType = data[3]

  if (addressType === 0x01) { // IPv4
    if (data.length < 10) return { errorCode: SOCKS_REPLY.generalFailure }
    const host = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`
    return { host, port: data.readUInt16BE(8) }
  }

  if (addressType === 0x03) { // domain name
    const len = data[4]
    if (data.length < 5 + len + 2) return { errorCode: SOCKS_REPLY.generalFailure }
    const host = data.subarray(5, 5 + len).toString('utf8')
    if (!host || host.includes('\0')) return { errorCode: SOCKS_REPLY.generalFailure }
    return { host, port: data.readUInt16BE(5 + len) }
  }

  if (addressType === 0x04) { // IPv6
    if (data.length < 22) return { errorCode: SOCKS_REPLY.generalFailure }
    const groups: string[] = []
    for (let i = 0; i < 16; i += 2) {
      groups.push(data.readUInt16BE(4 + i).toString(16))
    }
    return { host: groups.join(':'), port: data.readUInt16BE(20) }
  }

  return { errorCode: SOCKS_REPLY.addressTypeNotSupported }
}
