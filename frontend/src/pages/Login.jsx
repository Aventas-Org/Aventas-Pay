import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, Eye, EyeOff, ArrowRight, ShieldCheck, AlertCircle, Lock } from 'lucide-react';
import { AvMark, AvWordmark, HazardStripe } from '../components/AvLogo.jsx';

export default function Login() {
  const navigate = useNavigate();
  const [secretKey, setSecretKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [lockoutSecs, setLockoutSecs] = useState(0);
  const [shaking, setShaking] = useState(false);
  const [btnPopping, setBtnPopping] = useState(false);

  // Trigger A4 spring pop when key becomes non-empty
  const handleKeyChange = (e) => {
    const val = e.target.value;
    const wasEmpty = !secretKey.trim();
    setSecretKey(val);
    setError('');
    if (wasEmpty && val.trim()) {
      setBtnPopping(true);
      setTimeout(() => setBtnPopping(false), 450);
    }
  };

  useEffect(() => {
    // If already logged in, verify session
    const existing = localStorage.getItem('aventas_admin_key');
    if (existing) {
      fetch('/api/admin/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secretKey: existing }),
      })
        .then((res) => {
          if (res.ok) navigate('/');
        })
        .catch(() => {});
    }
  }, [navigate]);

  useEffect(() => {
    if (lockoutSecs <= 0) return;
    const t = setInterval(() => setLockoutSecs((prev) => prev - 1), 1000);
    return () => clearInterval(t);
  }, [lockoutSecs]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (lockoutSecs > 0) return;
    setError('');

    const cleanKey = secretKey.trim();
    if (!cleanKey) {
      setError('Please enter your universal secret key');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/admin/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secretKey: cleanKey }),
      });

      const data = await res.json();
      if (res.ok && data.valid) {
        localStorage.setItem('aventas_admin_key', cleanKey);
        navigate('/');
      } else {
        // A4: Wrong key shake
        setShaking(true);
        setTimeout(() => setShaking(false), 450);

        const nextAttempts = attempts + 1;
        setAttempts(nextAttempts);
        if (nextAttempts >= 5) {
          setLockoutSecs(900); // 15 minutes lockout
          setError('Too many failed attempts. Locked out for 15 minutes.');
        } else {
          setError(data.error || 'Invalid secret key. Access denied.');
        }
      }
    } catch (err) {
      setShaking(true);
      setTimeout(() => setShaking(false), 450);
      setError('Connection error. Server may be offline.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg, #0A0A0B)',
        color: 'var(--bone, #E9E6DF)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
        fontFamily: 'var(--font-body)',
      }}
    >
      {/* Brand Header with A1 Draw-in & Wordmark Letter Stagger */}
      <div style={{ textAlign: 'center', marginBottom: 28 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 14 }}>
          <AvMark size={48} animated={true} />
        </div>
        <AvWordmark subtitle="ADMIN CONSOLE" animated={true} style={{ alignItems: 'center' }} />
        <p style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 8 }}>
          Enter your universal secret key to access the control panel
        </p>
      </div>

      {/* Login Card with A2 Hazard Stripe Top Accent and A4 Shake */}
      <div
        className={shaking ? 'motion-shake' : ''}
        style={{
          width: '100%',
          maxWidth: 400,
          background: 'var(--surface, #111113)',
          border: '1px solid var(--border, #27272A)',
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: 'var(--shadow-subtle)',
        }}
      >
        {/* A2: 4px Continuous Hazard Stripe Accent */}
        <HazardStripe height={4} />

        <div style={{ padding: '26px 24px' }}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {error && (
              <div
                style={{
                  background: 'var(--bad-bg)',
                  border: '1px solid var(--bad-border)',
                  color: 'var(--bad)',
                  padding: '12px 14px',
                  borderRadius: 8,
                  fontSize: 12.5,
                  fontWeight: 500,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  boxShadow: '0 4px 12px rgba(239, 68, 68, 0.12)',
                }}
              >
                <AlertCircle size={17} style={{ flexShrink: 0, color: 'var(--bad)' }} />
                <span>{error}</span>
              </div>
            )}

            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--muted)',
                  marginBottom: 8,
                }}
              >
                Admin Secret Key
              </label>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <KeyRound
                  size={15}
                  strokeWidth={1.5}
                  style={{
                    position: 'absolute',
                    left: 12,
                    color: 'var(--muted)',
                    pointerEvents: 'none',
                  }}
                />
                <input
                  type={showKey ? 'text' : 'password'}
                  value={secretKey}
                  onChange={handleKeyChange}
                  placeholder="Enter admin key"
                  disabled={lockoutSecs > 0}
                  autoFocus
                  style={{
                    width: '100%',
                    height: 42,
                    padding: '0 40px 0 36px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    background: 'var(--raised)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    color: 'var(--bone)',
                    outline: 'none',
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  style={{
                    position: 'absolute',
                    right: 12,
                    color: 'var(--muted)',
                    padding: 4,
                  }}
                  tabIndex={-1}
                >
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {/* A4: Sign-in button with pop on enable and inline spinner */}
            <button
              type="submit"
              disabled={loading || lockoutSecs > 0 || !secretKey.trim()}
              className={`btn primary ${btnPopping ? 'motion-btn-pop' : ''}`}
              style={{
                width: '100%',
                height: 42,
                fontSize: 13,
                background: (!secretKey.trim() || loading || lockoutSecs > 0) ? 'var(--raised)' : 'var(--bone)',
                color: (!secretKey.trim() || loading || lockoutSecs > 0) ? 'var(--muted)' : 'var(--bg)',
                border: (!secretKey.trim() || loading || lockoutSecs > 0) ? '1px solid var(--border)' : '1px solid var(--bone)',
                opacity: (!secretKey.trim() || loading || lockoutSecs > 0) ? 0.40 : 1,
                cursor: (!secretKey.trim() || loading || lockoutSecs > 0) ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              {loading ? (
                <>
                  <span className="motion-spinner" />
                  <span>Verifying...</span>
                </>
              ) : lockoutSecs > 0 ? (
                <span>Locked out ({lockoutSecs}s)</span>
              ) : (
                <>
                  <span>Sign In</span>
                  <ArrowRight size={15} strokeWidth={1.5} />
                </>
              )}
            </button>
          </form>

          <div
            style={{
              marginTop: 20,
              paddingTop: 16,
              borderTop: '1px solid var(--border-subtle)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              fontSize: 11,
              color: 'var(--muted)',
            }}
          >
            <ShieldCheck size={14} strokeWidth={1.5} color="var(--ok)" />
            <span>Cryptographic session authorization</span>
          </div>
        </div>
      </div>
    </div>
  );
}
