import { describe, it, expect } from 'vitest'
import { looksLikeHost, parseQuickConnectTarget } from '../quickConnect'

describe('parseQuickConnectTarget', () => {
  it.each([
    ['deploy@web.example.com', { username: 'deploy', host: 'web.example.com', port: 22 }],
    ['deploy@10.0.0.5:2222', { username: 'deploy', host: '10.0.0.5', port: 2222 }],
    ['web.example.com', { username: '', host: 'web.example.com', port: 22 }],
    ['host:2200', { username: '', host: 'host', port: 2200 }],
    ['ssh deploy@host -p 2222', { username: 'deploy', host: 'host', port: 2222 }],
    ['ssh -p 2222 deploy@host', { username: 'deploy', host: 'host', port: 2222 }],
    ['  root@box  ', { username: 'root', host: 'box', port: 22 }],
    ['ssh://admin@db.internal:2022', { username: 'admin', host: 'db.internal', port: 2022 }],
    ['ssh://db.internal', { username: '', host: 'db.internal', port: 22 }],
    ['user@[2001:db8::1]:2222', { username: 'user', host: '2001:db8::1', port: 2222 }],
    ['user@2001:db8::1', { username: 'user', host: '2001:db8::1', port: 22 }],
    ['first.last@corp@bastion', { username: 'first.last@corp', host: 'bastion', port: 22 }],
    ['ssh -i ~/.ssh/work -J jump deploy@host', { username: 'deploy', host: 'host', port: 22 }],
    ['ssh -l admin box.local', { username: 'admin', host: 'box.local', port: 22 }],
  ])('parses %s', (input, expected) => {
    expect(parseQuickConnectTarget(input)).toEqual(expected)
  })

  it.each([
    [''],
    ['ssh'],
    ['user@'],
    ['user@host:99999'],
    ['user@host:abc'],
    ['ssh host -p 0'],
    ['user@ho st'],
    ['ssh host uptime'],
    ['user@host/path'],
    ['user@[::1'],
    ['user@[::1]x'],
    ['ssh://user@:22'],
  ])('rejects %j', (input) => {
    expect(parseQuickConnectTarget(input)).toBeNull()
  })
})

describe('looksLikeHost', () => {
  it('only treats host-shaped palette queries as hosts', () => {
    expect(looksLikeHost('deploy@web')).toBe(true)
    expect(looksLikeHost('10.0.0.5')).toBe(true)
    expect(looksLikeHost('box:2222')).toBe(true)
    expect(looksLikeHost('ssh web')).toBe(true)
    expect(looksLikeHost('production')).toBe(false)
    expect(looksLikeHost('docker')).toBe(false)
    expect(looksLikeHost('prod web.example.com')).toBe(false)
  })
})
