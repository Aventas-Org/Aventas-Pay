import { test } from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

test('QR Code Generation & Decoding - Decodes to valid UPI Intent URI', async () => {
  const vpa = 'cvvbypasser@slc';
  const amount = '499.05';
  const orderId = 'pay_test_qr_verify_123';
  const upiUri = `upi://pay?pa=${vpa}&pn=${encodeURIComponent('Aventas Pay')}&am=${amount}&cu=INR&tn=${encodeURIComponent(orderId)}`;

  // Generate PNG buffer with High error correction level (level H)
  const pngBuffer = await QRCode.toBuffer(upiUri, {
    width: 320,
    margin: 2,
    errorCorrectionLevel: 'H',
    color: { dark: '#000000', light: '#ffffff' },
  });

  const parsed = PNG.sync.read(pngBuffer);
  const code = jsQR(new Uint8ClampedArray(parsed.data), parsed.width, parsed.height);

  assert.ok(code, 'QR Code should be successfully detected and decoded');
  assert.equal(code.data, upiUri, 'Decoded QR string must exactly match original UPI intent URI');
  assert.match(code.data, /^upi:\/\/pay\?pa=cvvbypasser@slc&pn=Aventas%20Pay&am=499\.05&cu=INR&tn=pay_test_qr_verify_123$/);
});

test('QR Code with Center Overlay - Error correction level H recovers data with simulated center occlusion', async () => {
  const vpa = 'cvvbypasser@slc';
  const amount = '1.01';
  const orderId = 'pay_occlusion_test';
  const upiUri = `upi://pay?pa=${vpa}&pn=${encodeURIComponent('Aventas Pay')}&am=${amount}&cu=INR&tn=${encodeURIComponent(orderId)}`;

  const pngBuffer = await QRCode.toBuffer(upiUri, {
    width: 320,
    margin: 2,
    errorCorrectionLevel: 'H',
  });

  const parsed = PNG.sync.read(pngBuffer);

  // Simulate center logo occlusion (up to 15% of width/height in the center)
  const centerSize = Math.floor(parsed.width * 0.15);
  const startX = Math.floor((parsed.width - centerSize) / 2);
  const startY = Math.floor((parsed.height - centerSize) / 2);

  for (let y = startY; y < startY + centerSize; y++) {
    for (let x = startX; x < startX + centerSize; x++) {
      const idx = (parsed.width * y + x) << 2;
      parsed.data[idx] = 255;     // R
      parsed.data[idx + 1] = 255; // G
      parsed.data[idx + 2] = 255; // B
      parsed.data[idx + 3] = 255; // A
    }
  }

  const code = jsQR(new Uint8ClampedArray(parsed.data), parsed.width, parsed.height);
  assert.ok(code, 'Level H QR code must decode even with center brand mark overlay');
  assert.equal(code.data, upiUri);
});
