import React from 'react';

/**
 * Angular "AV" Brand Mark
 * Uses theme bone (#E9E6DF) with optional custom color, size, and dark mode for light backgrounds (e.g. QR overlay)
 */
export function AvMark({ size = 28, className = '', color = 'var(--bone, #E9E6DF)', dark = false, animated = false, style = {} }) {
  const isDarkMark = dark || color === '#0A0A0B' || color === '#000000';
  const fillValue = isDarkMark ? '#0A0A0B' : 'url(#av-bone-grad)';
  const strokeColor = isDarkMark ? '#0A0A0B' : color;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="170 300 915 640"
      width={size}
      height={size * (640 / 915)}
      fill="none"
      className={`${className} ${animated ? 'motion-av-draw' : ''}`}
      style={{ display: 'inline-block', flexShrink: 0, verticalAlign: 'middle', ...style }}
    >
      {!isDarkMark && (
        <defs>
          <linearGradient id="av-bone-grad" gradientUnits="userSpaceOnUse" x1="560" y1="354" x2="700" y2="885">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="25%" stopColor="#F5F3ED" />
            <stop offset="70%" stopColor={color} />
            <stop offset="100%" stopColor="#D4CFBF" />
          </linearGradient>
        </defs>
      )}
      <g>
        <polygon
          pathLength="1"
          fill={fillValue}
          stroke={strokeColor}
          strokeOpacity={isDarkMark ? '1' : '0.8'}
          strokeWidth="2"
          points="499,354 605,609 532,641 490,546 374,764 474,767 220,882"
        />
        <polygon
          pathLength="1"
          fill={fillValue}
          stroke={strokeColor}
          strokeOpacity={isDarkMark ? '1' : '0.8'}
          strokeWidth="2"
          points="522,674 439,714 422,743 549,743"
        />
        <polygon
          pathLength="1"
          fill={fillValue}
          stroke={strokeColor}
          strokeOpacity={isDarkMark ? '1' : '0.8'}
          strokeWidth="2"
          points="613,631 543,663 586,764 517,767 718,878"
        />
        <polygon
          pathLength="1"
          fill={fillValue}
          stroke={strokeColor}
          strokeOpacity={isDarkMark ? '1' : '0.8'}
          strokeWidth="2"
          points="526,359 628,597 700,565 660,469 729,466"
        />
        <polygon
          pathLength="1"
          fill={fillValue}
          stroke={strokeColor}
          strokeOpacity={isDarkMark ? '1' : '0.8'}
          strokeWidth="2"
          points="1031,356 770,466 878,470 757,693 711,587 639,619 748,885"
        />
      </g>
    </svg>
  );
}

/**
 * Wide-tracked "AVENTAS" Wordmark
 */
export function AvWordmark({ className = '', subtitle = '', animated = false, style = {} }) {
  const letters = 'AVENTAS'.split('');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', ...style }} className={className}>
      <span
        style={{
          fontFamily: "'Syncopate', 'Space Grotesk', system-ui, sans-serif",
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--bone, #E9E6DF)',
          lineHeight: 1.1,
        }}
      >
        {animated
          ? letters.map((char, i) => (
              <span key={i} className="motion-wm-char" style={{ '--char-i': i }}>
                {char}
              </span>
            ))
          : 'AVENTAS'}
      </span>
      {subtitle && (
        <span
          style={{
            fontSize: 9,
            fontWeight: 500,
            letterSpacing: '0.08em',
            color: 'var(--muted, #8A8A93)',
            marginTop: 2,
            textTransform: 'uppercase',
          }}
        >
          {subtitle}
        </span>
      )}
    </div>
  );
}

/**
 * Brand Logo + Wordmark combo
 */
export function AvBrand({ size = 26, subtitle = 'GATEWAY', className = '', style = {} }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, ...style }} className={className}>
      <AvMark size={size} />
      <AvWordmark subtitle={subtitle} />
    </div>
  );
}

/**
 * Diagonal 4px Hazard Stripe Accent Bar
 * Spec: 4px diagonal hazard-stripe accent (--warn on --bg) on top of the login card and pay-page card header ONLY
 */
export function HazardStripe({ height = 4, className = '', style = {} }) {
  return (
    <div
      className={`motion-hazard ${className}`}
      style={{
        width: '100%',
        height,
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

export default AvBrand;
