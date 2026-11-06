import { useMemo } from 'react';
import QRCode from 'qrcode';

/** QR drawn as SVG so each module can wave in diagonally (demo A19). Fully scannable at rest. */
export default function AnimatedQr({ text, size = 222 }) {
  const grid = useMemo(() => {
    try {
      const q = QRCode.create(text, { errorCorrectionLevel: 'H' });
      const n = q.modules.size;
      const dark = [];
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.modules.get(y, x)) dark.push([x, y]);
      return { n, dark };
    } catch { return null; }
  }, [text]);
  if (!grid) return null;
  return (
    <svg className="qr-svg" viewBox={`-1 -1 ${grid.n + 2} ${grid.n + 2}`} width={size} height={size}
      shapeRendering="crispEdges" role="img" aria-label="UPI QR Code" style={{ width: size, height: size, display: 'block' }}>
      {grid.dark.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width="1.04" height="1.04" fill="#0A0A0B" style={{ animationDelay: `${(x + y) * 16}ms` }} />
      ))}
    </svg>
  );
}
