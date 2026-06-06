#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const iconPath = resolve(rootDir, 'resources/app-icon.png')
const buildIconPath = resolve(rootDir, 'build/icon.png')
const CRC_TABLE = createCrcTable()

const icon = decodePng(readFileSync(iconPath))
const maskedIcon = applyMacosMask(icon)
const png = encodePng(maskedIcon)

writeFileSync(iconPath, png)
writeFileSync(buildIconPath, png)

console.log(`Wrote rounded macOS app icons:\n- ${iconPath}\n- ${buildIconPath}`)

function applyMacosMask(image) {
  const { width, height, data } = image
  const output = Buffer.from(data)
  const cx = width / 2
  const cy = height / 2
  const rx = width / 2
  const ry = height / 2
  const exponent = 4.6
  const samples = 4
  const totalSamples = samples * samples

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let covered = 0

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = (x + (sx + 0.5) / samples - cx) / rx
          const py = (y + (sy + 0.5) / samples - cy) / ry

          if (Math.abs(px) ** exponent + Math.abs(py) ** exponent <= 1) {
            covered += 1
          }
        }
      }

      const offset = (y * width + x) * 4 + 3
      output[offset] = Math.round((covered / totalSamples) * 255)
    }
  }

  return { width, height, data: output }
}

function decodePng(buffer) {
  assert(
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'input is not a PNG'
  )

  let offset = 8
  let ihdr = null
  const idatChunks = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += length + 12

    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12]
      }
    } else if (type === 'IDAT') {
      idatChunks.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  assert(ihdr, 'PNG is missing IHDR')
  assert(ihdr.bitDepth === 8, 'only 8-bit PNGs are supported')
  assert(ihdr.colorType === 2 || ihdr.colorType === 6, 'only RGB/RGBA PNGs are supported')
  assert(ihdr.compression === 0 && ihdr.filter === 0 && ihdr.interlace === 0, 'unsupported PNG encoding')

  const bytesPerPixel = ihdr.colorType === 6 ? 4 : 3
  const stride = ihdr.width * bytesPerPixel
  const inflated = inflateSync(Buffer.concat(idatChunks))
  const pixels = Buffer.alloc(ihdr.height * stride)
  let readOffset = 0

  for (let y = 0; y < ihdr.height; y += 1) {
    const filter = inflated[readOffset]
    readOffset += 1

    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[readOffset + x]
      const left = x >= bytesPerPixel ? pixels[y * stride + x - bytesPerPixel] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = y > 0 && x >= bytesPerPixel ? pixels[(y - 1) * stride + x - bytesPerPixel] : 0

      pixels[y * stride + x] = (raw + pngFilterPrediction(filter, left, up, upLeft)) & 0xff
    }

    readOffset += stride
  }

  if (ihdr.colorType === 6) {
    return { width: ihdr.width, height: ihdr.height, data: pixels }
  }

  const rgba = Buffer.alloc(ihdr.width * ihdr.height * 4)
  for (let source = 0, target = 0; source < pixels.length; source += 3, target += 4) {
    rgba[target] = pixels[source]
    rgba[target + 1] = pixels[source + 1]
    rgba[target + 2] = pixels[source + 2]
    rgba[target + 3] = 255
  }

  return { width: ihdr.width, height: ihdr.height, data: rgba }
}

function encodePng(image) {
  const { width, height, data } = image
  const bytesPerPixel = 4
  const stride = width * bytesPerPixel
  const filtered = Buffer.alloc(height * (stride + 1))

  for (let y = 0; y < height; y += 1) {
    const row = data.subarray(y * stride, (y + 1) * stride)
    const previousRow = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null
    const encoded = chooseFilteredRow(row, previousRow, bytesPerPixel)
    encoded.copy(filtered, y * (stride + 1))
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', createIhdr(width, height)),
    pngChunk('IDAT', deflateSync(filtered, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function chooseFilteredRow(row, previousRow, bytesPerPixel) {
  let bestRow = null
  let bestScore = Infinity

  for (let filter = 0; filter <= 4; filter += 1) {
    const encoded = Buffer.alloc(row.length + 1)
    encoded[0] = filter
    let score = 0

    for (let x = 0; x < row.length; x += 1) {
      const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0
      const up = previousRow ? previousRow[x] : 0
      const upLeft = previousRow && x >= bytesPerPixel ? previousRow[x - bytesPerPixel] : 0
      const value = (row[x] - pngFilterPrediction(filter, left, up, upLeft)) & 0xff

      encoded[x + 1] = value
      score += value < 128 ? value : 256 - value
    }

    if (score < bestScore) {
      bestScore = score
      bestRow = encoded
    }
  }

  return bestRow
}

function pngFilterPrediction(filter, left, up, upLeft) {
  if (filter === 0) return 0
  if (filter === 1) return left
  if (filter === 2) return up
  if (filter === 3) return Math.floor((left + up) / 2)
  if (filter === 4) return paeth(left, up, upLeft)
  throw new Error(`unsupported PNG filter type: ${filter}`)
}

function paeth(left, up, upLeft) {
  const prediction = left + up - upLeft
  const leftDelta = Math.abs(prediction - left)
  const upDelta = Math.abs(prediction - up)
  const upLeftDelta = Math.abs(prediction - upLeft)

  if (leftDelta <= upDelta && leftDelta <= upLeftDelta) return left
  if (upDelta <= upLeftDelta) return up
  return upLeft
}

function createIhdr(width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return ihdr
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBuffer.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), chunk.length - 4)
  return chunk
}

function crc32(buffer) {
  let crc = 0xffffffff

  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}

function createCrcTable() {
  const table = new Uint32Array(256)

  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }

  return table
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
