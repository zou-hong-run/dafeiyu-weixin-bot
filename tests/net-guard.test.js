import test from 'node:test'
import assert from 'node:assert/strict'
import { assertPublicUrl, isBlockedAddress } from '../src/mcp-server/net-guard.js'

test('内网和云元数据地址被挡', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254', // 云厂商元数据
    '0.0.0.0',
    '::1',
    'fd00::1',
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} 应该被挡`)
  }
})

test('公网地址放行', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.5', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} 不该被挡`)
  }
})

test('非 http(s) 协议被拒', () => {
  assert.throws(() => assertPublicUrl('file:///etc/passwd'))
  assert.throws(() => assertPublicUrl('ftp://example.com/x'))
  assert.throws(() => assertPublicUrl('javascript:alert(1)'))
})

test('格式不对的地址被拒', () => {
  assert.throws(() => assertPublicUrl(''))
  assert.throws(() => assertPublicUrl('not-a-url'))
  assert.throws(() => assertPublicUrl('example.com'))
})

test('字面内网地址被拒', () => {
  assert.throws(() => assertPublicUrl('http://127.0.0.1/x'))
  assert.throws(() => assertPublicUrl('http://192.168.1.1/x'))
  assert.throws(() => assertPublicUrl('http://169.254.169.254/latest/meta-data'))
  assert.throws(() => assertPublicUrl('http://localhost:3000/x'))
})

test('正常公网地址返回 URL 对象', () => {
  const url = assertPublicUrl('https://example.com/path?q=1')
  assert.equal(url.hostname, 'example.com')
  assert.equal(url.protocol, 'https:')
})
