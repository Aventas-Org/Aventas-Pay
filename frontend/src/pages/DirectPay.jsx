import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import AnimatedQr from '../components/AnimatedQr';
import {
  CheckCircle2, Clock, AlertTriangle, ShieldCheck,
  Smartphone, RefreshCw, MessageCircle, Send, X, Download, ArrowRight, ExternalLink
} from 'lucide-react';
import { AvMark, AvWordmark, HazardStripe } from '../components/AvLogo.jsx';
import { inr } from '../data.js';

// Helper: Validate return URLs to ensure safe HTTPS or localhost navigation (no example.com or empty defaults)
function isValidReturnUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (trimmed.includes('example.com') || trimmed.includes('placeholder')) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

export default function DirectPay() {
  const { productId } = useParams();
  const navigate = useNavigate();

  const [product, setProduct] = useState(null);
  const [order, setOrder] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [upiUrl, setUpiUrl] = useState('');
  const [status, setStatus] = useState('loading'); // loading, pending, success, expired, error
  const [timeLeft, setTimeLeft] = useState(600); // in seconds
  const [initialTotalTime, setInitialTotalTime] = useState(600);
  const [confirmData, setConfirmData] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [redirectCountdown, setRedirectCountdown] = useState(5);

  // Live Chat state for manual review
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [sendingMsg, setSendingMsg] = useState(false);

  const timerRef = useRef(null);
  const pollRef = useRef(null);
  const chatPollRef = useRef(null);
  const chatEndRef = useRef(null);
  const currentPaymentIdRef = useRef(null);

  // 1. Fetch Product / Existing Order and Initialize
  useEffect(() => {
    let isCancelled = false;

    if (currentPaymentIdRef.current && currentPaymentIdRef.current === productId) {
      return;
    }

    async function initCheckout() {
      try {
        setStatus('loading');

        const isExistingOrder = Boolean(
          productId && (productId.startsWith('pay_') || productId.startsWith('demo_') || productId.startsWith('ORD-') || productId.startsWith('ord_'))
        );

        if (isExistingOrder) {
          const res = await fetch(`/api/payments/${productId}`);
          if (!res.ok) {
            throw new Error(`Order ${productId} not found`);
          }
          const orderData = await res.json();
          if (isCancelled) return;

          currentPaymentIdRef.current = orderData.paymentId;
          setOrder(orderData);
          setProduct({
            id: orderData.paymentId,
            name: orderData.productName || 'Direct UPI Payment',
            description: 'Instant UPI Checkout',
            baseAmount: orderData.baseAmount || Math.floor(orderData.amount),
          });

          const expiryMs = new Date(orderData.expiresAt).getTime();
          const remainingSecs = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000));
          setTimeLeft(remainingSecs);
          setInitialTotalTime(Math.max(600, remainingSecs));

          if (orderData.status === 'SUCCESS' || orderData.status === 'PAID') {
            setStatus('success');
            setConfirmData(orderData);
            return;
          }

          if (orderData.status === 'EXPIRED' || remainingSecs <= 0) {
            setStatus('expired');
            return;
          }

          // The server builds this from the UPI ID configured in Settings.
          const upi = orderData.upiIntent;
          if (!upi) throw new Error('Payment is not available for this order');
          setUpiUrl(upi);

          const qrUrl = await QRCode.toDataURL(upi, {
            width: 320,
            margin: 1.5,
            errorCorrectionLevel: 'H',
            color: { dark: '#000000', light: '#ffffff' },
          });

          if (isCancelled) return;
          setQrDataUrl(qrUrl);
          setStatus('pending');
          return;
        }

        // Product catalog path
        let prodInfo = {
          id: productId || 'product_direct',
          name: 'Direct UPI Payment',
          description: 'Secure instant UPI checkout',
          baseAmount: 1,
        };

        try {
          const pRes = await fetch(`/api/products/${productId}`);
          if (pRes.ok) {
            prodInfo = await pRes.json();
          }
        } catch (e) {
          console.warn('Using default product info for direct pay:', e);
        }

        if (isCancelled) return;
        setProduct(prodInfo);

        const createRes = await fetch('/api/payments/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseAmount: prodInfo.baseAmount,
            product_name: prodInfo.name,
          }),
        });

        if (!createRes.ok) {
          throw new Error(`Failed to create order: ${createRes.status}`);
        }

        const orderData = await createRes.json();
        if (isCancelled) return;

        currentPaymentIdRef.current = orderData.paymentId;
        setOrder(orderData);

        const upi = orderData.upiIntent;
        if (!upi) throw new Error('Payment is not available for this order');
        setUpiUrl(upi);

        const qrUrl = await QRCode.toDataURL(upi, {
          width: 320,
          margin: 1.5,
          errorCorrectionLevel: 'H',
          color: { dark: '#000000', light: '#ffffff' },
        });

        if (isCancelled) return;
        setQrDataUrl(qrUrl);
        setStatus('pending');

        navigate(`/pay/${orderData.paymentId}`, { replace: true });
      } catch (err) {
        if (!isCancelled) {
          setStatus('error');
          setErrorMessage(err.message || 'Failed to initialize payment');
        }
      }
    }

    initCheckout();

    return () => {
      isCancelled = true;
    };
  }, [productId, navigate]);

  // 2. Countdown Timer
  useEffect(() => {
    if (status !== 'pending') return;

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          setStatus('expired');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timerRef.current);
  }, [status]);

  // 3. Status Poller (Check every 2 seconds)
  useEffect(() => {
    if (!order || status === 'success') return;

    const checkStatus = async () => {
      try {
        const res = await fetch(`/api/payments/${order.paymentId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'SUCCESS' || data.status === 'PAID') {
            setStatus('success');
            setConfirmData(data);
            clearInterval(pollRef.current);
            return;
          }
          if (data.status === 'EXPIRED' && status !== 'expired') {
            setStatus('expired');
          }
        }
      } catch (err) {
        console.warn('Poll error:', err);
      }
    };

    pollRef.current = setInterval(checkStatus, 2000);
    return () => clearInterval(pollRef.current);
  }, [status, order]);

  // Success redirect & postMessage
  useEffect(() => {
    if (status !== 'success') return;
    const rawRedirect = order?.redirectUrl || product?.redirectUrl || confirmData?.redirectUrl;
    const targetRedirect = isValidReturnUrl(rawRedirect) ? rawRedirect : null;

    if (window.parent) {
      window.parent.postMessage(
        {
          event: 'aventas:paid',
          type: 'AVENTAS_PAYMENT_SUCCESS',
          orderId: order?.paymentId,
          paymentId: order?.paymentId,
          amount: order?.amount || confirmData?.amount,
          utr: confirmData?.rrn || confirmData?.provider_transaction_ref || 'verified',
          redirectUrl: targetRedirect || '',
          timestamp: Date.now(),
        },
        '*'
      );
    }

    if (targetRedirect) {
      const timer = setInterval(() => {
        setRedirectCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(timer);
            try {
              if (window.top && window.top !== window) {
                window.top.location.href = targetRedirect;
              } else {
                window.location.href = targetRedirect;
              }
            } catch {
              window.location.href = targetRedirect;
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [status, order, product, confirmData]);

  // 4. Live Chat Poller
  useEffect(() => {
    if (!showChat || !order) return;

    const fetchMessages = async () => {
      try {
        const res = await fetch(`/api/chat/${order.paymentId}/messages`);
        if (res.ok) {
          const msgs = await res.json();
          setChatMessages(msgs);
        }
      } catch (e) {
        console.warn('Chat poll error:', e);
      }
    };

    fetchMessages();
    chatPollRef.current = setInterval(fetchMessages, 2000);
    return () => clearInterval(chatPollRef.current);
  }, [showChat, order]);

  useEffect(() => {
    if (showChat) {
      chatEndRef.current?.scrollIntoView({ behavior: 'auto' });
      const timer = setTimeout(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [chatMessages, showChat]);

  const openChatSupport = async () => {
    setShowChat(true);
    if (!order) return;
    try {
      await fetch('/api/chat/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: order.paymentId,
          customerName: 'UPI Customer',
          amount: order.amount,
        }),
      });
    } catch (e) {
      console.warn('Failed to start chat session:', e);
    }
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!messageInput.trim() || !order) return;
    const msg = messageInput.trim();
    setMessageInput('');

    setSendingMsg(true);
    try {
      const res = await fetch(`/api/chat/${order.paymentId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: 'customer',
          message: msg,
        }),
      });
      if (res.ok) {
        const newMsg = await res.json();
        setChatMessages((prev) => [...prev, newMsg]);
      }
    } catch (err) {
      console.error('Send message failed:', err);
    } finally {
      setSendingMsg(false);
    }
  };

  const downloadReceipt = () => {
    const text = `=========================================
AVENTAS PAY - OFFICIAL RECEIPT
=========================================
Order ID:       ${order?.paymentId || '—'}
Amount Paid:    ${inr(order?.amount || confirmData?.amount)}
Payment Method: UPI (Slice Bank Auto-Verified)
Reference UTR:  ${confirmData?.rrn || confirmData?.provider_transaction_ref || 'Verified'}
Status:         CONFIRMED / PAID
Date:           ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
Payee:          AventasPay Gateway
=========================================
Thank you for your transaction.
`;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Receipt_${order?.paymentId || 'payment'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatTime = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const progressPercent = Math.max(0, Math.min(100, (timeLeft / (initialTotalTime || 600)) * 100));
  const isHttps = typeof window !== 'undefined' && window.location.protocol === 'https:';

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg, #0A0A0B)',
        color: 'var(--bone, #E9E6DF)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '36px 16px',
        fontFamily: 'var(--font-body)',
      }}
    >
      {/* Top Header Bar */}
      <div
        style={{
          width: '100%',
          maxWidth: 440,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <AvMark size={22} />
          <span
            style={{
              fontFamily: 'var(--font-brand)',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.14em',
              color: 'var(--bone)',
            }}
          >
            AVENTAS PAY
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            color: 'var(--ok)',
            fontFamily: 'var(--font-body)',
            fontWeight: 500,
          }}
        >
          <ShieldCheck size={14} />
          <span>{isHttps ? 'Encrypted Gateway' : 'Secure checkout'}</span>
        </div>
      </div>

      {/* Main Checkout Card */}
      <div
        style={{
          width: '100%',
          maxWidth: 440,
          background: 'var(--surface, #111113)',
          border: '1px solid var(--border, #27272A)',
          borderRadius: 14,
          overflow: 'hidden',
          boxShadow: 'var(--shadow-subtle)',
        }}
      >
        {/* 4px Hazard Stripe Accent on top of the pay-page card header ONLY */}
        <HazardStripe height={4} />

        {/* Card Header: "Pay ₹X to AventasPay" with payee name */}
        <div
          style={{
            padding: '20px 22px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--raised, #18181B)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>
              Pay to <strong style={{ color: 'var(--bone)' }}>AventasPay</strong>
            </div>
            <div
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 16,
                fontWeight: 700,
                color: 'var(--bone)',
                marginTop: 2,
              }}
            >
              {product?.name || 'Instant UPI Checkout'}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div
              className="mono"
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: 'var(--bone)',
                letterSpacing: '-0.02em',
              }}
            >
              {order ? inr(order.amount) : product ? inr(product.baseAmount) : inr(0)}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 2 }}>
              {order?.paymentId ? order.paymentId : 'ORDER PENDING'}
            </div>
          </div>
        </div>

        {/* 1. LOADING STATE */}
        {status === 'loading' && (
          <div style={{ padding: 48, textAlign: 'center' }}>
            <RefreshCw size={28} className="spin" style={{ margin: '0 auto 12px', color: 'var(--accent)' }} />
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--bone)' }}>
              Initializing Secure Session...
            </div>
          </div>
        )}

        {/* 2. ERROR STATE */}
        {status === 'error' && (
          <div style={{ padding: 40, textAlign: 'center' }}>
            <AlertTriangle size={36} style={{ margin: '0 auto 12px', color: 'var(--bad)' }} />
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--bad)' }}>Session Initialization Error</div>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px 0 16px' }}>{errorMessage}</p>
            <button
              onClick={() => window.location.reload()}
              className="btn secondary"
            >
              Retry
            </button>
          </div>
        )}

        {/* 3. EXPIRED STATE */}
        {status === 'expired' && (
          <div style={{ padding: '36px 24px', textAlign: 'center' }}>
            <div className="motion-expired-clock">
              <Clock size={26} strokeWidth={1.5} />
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 17, fontWeight: 700, color: 'var(--bone)' }}>
              Payment Window Expired
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '10px auto 22px', maxWidth: 350, lineHeight: 1.55 }}>
              You haven&apos;t paid yet. If money was debited, contact support and we&apos;ll verify it.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                onClick={openChatSupport}
                className="btn primary"
                style={{ width: '100%', height: 42 }}
              >
                <MessageCircle size={15} strokeWidth={1.5} />
                <span>Contact support</span>
              </button>

              <button
                onClick={() => {
                  navigate('/pay/test_slice_1rs');
                  window.location.reload();
                }}
                className="btn secondary"
                style={{ width: '100%', height: 40 }}
              >
                <RefreshCw size={13} strokeWidth={1.5} />
                <span>Create new payment</span>
              </button>
            </div>
          </div>
        )}

        {/* 4. SUCCESS STATE (Animated Checkmark + Receipt-Style Summary) */}
        {status === 'success' && (
          <div style={{ padding: '32px 24px', textAlign: 'center' }}>
            <div className="motion-success-mark" style={{ marginBottom: 16 }}>
              <svg viewBox="0 0 80 80">
                <circle className="motion-success-ring" pathLength="1" cx="40" cy="40" r="34" />
                <path className="motion-success-tick" pathLength="1" d="M26 41l10 10 19-21" />
              </svg>
              {Array.from({ length: 16 }, (_, i) => {
                const angle = (i / 16) * Math.PI * 2;
                const dist = 55 + (i % 3) * 12;
                const tx = Math.cos(angle) * dist;
                const ty = Math.sin(angle) * dist;
                return (
                  <i
                    key={i}
                    className="motion-particle"
                    style={{
                      '--tx': `${tx.toFixed(1)}px`,
                      '--ty': `${ty.toFixed(1)}px`,
                    }}
                  />
                );
              })}
            </div>

            <div style={{ fontFamily: 'var(--font-display)', fontSize: 20, fontWeight: 700, color: 'var(--bone)' }}>
              Payment Confirmed
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '6px 0 20px' }}>
              Your Slice Bank transaction was automatically verified.
            </p>

            {/* Receipt Summary Box */}
            <div
              className="motion-stagger-item"
              style={{
                background: 'var(--raised)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '16px 18px',
                textAlign: 'left',
                fontSize: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                marginBottom: 20,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)' }}>Amount Paid</span>
                <span className="mono" style={{ fontSize: 15, fontWeight: 700, color: 'var(--bone)' }}>
                  {inr(order?.amount || confirmData?.amount)}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)' }}>Order ID</span>
                <span className="mono" style={{ color: 'var(--bone)', fontSize: 11.5 }}>
                  {order?.paymentId}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)' }}>Reference (RRN / UTR)</span>
                <span className="mono" style={{ color: 'var(--bone)', fontWeight: 600 }}>
                  {confirmData?.rrn || confirmData?.provider_transaction_ref || 'Verified'}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)' }}>Settlement</span>
                <span className="badge status-ok">Slice UPI Matched</span>
              </div>
            </div>

            {/* Actions: Download Receipt & Return Button */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                onClick={downloadReceipt}
                className="btn secondary"
                style={{ width: '100%', height: 40 }}
              >
                <Download size={14} strokeWidth={1.5} />
                <span>Download receipt</span>
              </button>

              {(() => {
                const rawUrl = order?.redirectUrl || product?.redirectUrl || confirmData?.redirectUrl || order?.return_url || product?.return_url;
                if (!isValidReturnUrl(rawUrl)) return null;
                return (
                  <button
                    onClick={() => {
                      if (window.top && window.top !== window) window.top.location.href = rawUrl;
                      else window.location.href = rawUrl;
                    }}
                    className="btn primary motion-btn-fill"
                    style={{ width: '100%', height: 42 }}
                  >
                    <span>Back to merchant{redirectCountdown > 0 ? ` (${redirectCountdown}s)` : ''}</span>
                    <ArrowRight size={14} strokeWidth={1.5} />
                  </button>
                );
              })()}
            </div>
          </div>
        )}

        {/* 5. PENDING AWAITING PAYMENT STATE */}
        {status === 'pending' && (
          <div style={{ padding: '24px' }}>
            {/* Progress Countdown Bar */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Clock size={12} strokeWidth={1.5} />
                  <span>Time remaining</span>
                </span>
                <span className={`mono motion-countdown-digits ${timeLeft < 60 ? 'critical' : ''}`} style={{ color: timeLeft < 60 ? 'var(--bad)' : 'var(--warn)', fontWeight: 600 }}>
                  {formatTime(timeLeft)}
                </span>
              </div>
              <div className={`motion-countdown-bar ${timeLeft < 60 ? 'critical' : ''}`}>
                <i style={{ width: `${progressPercent}%` }} />
              </div>
            </div>

            {/* QR Code Container with Centered AV Mark (clean white rounded square with NO shadow, logo at most 18% of area) */}
            <div
              className="motion-qr-wrap"
              style={{
                background: '#ffffff',
                borderRadius: 14,
                padding: 14,
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                margin: '0 auto 18px',
                width: 250,
                height: 250,
                boxShadow: 'none',
                boxSizing: 'border-box',
                position: 'relative',
                '--qr-h': '250px',
              }}
            >
              <div style={{ position: 'relative', width: 222, height: 222 }}>
                {qrDataUrl && upiUrl ? (
                  <AnimatedQr text={upiUrl} size={222} />
                ) : (
                  <div style={{ width: 222, height: 222, display: 'grid', placeItems: 'center', color: '#000' }}>
                    Generating QR...
                  </div>
                )}

                {/* Centered AV Mark Icon Overlay (36x36 clean white rounded square, NO shadow) */}
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    pointerEvents: 'none',
                  }}
                >
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: '#ffffff',
                      border: '1.5px solid #E9E6DF',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      padding: 4,
                      boxShadow: 'none',
                    }}
                  >
                    <AvMark size={22} dark={true} color="#0A0A0B" />
                  </div>
                </div>
              </div>
              {/* Thin Scan Line Sweep */}
              <div className="motion-scan-line" />
            </div>

            {/* Waiting for payment pulse indicator */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '8px 12px',
                background: 'var(--raised)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                fontSize: 12,
                color: 'var(--bone)',
                marginBottom: 16,
              }}
            >
              <span
                className="motion-pulse-dot pulse"
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: 'var(--warn)',
                  display: 'inline-block',
                }}
              />
              <span style={{ fontWeight: 500 }}>Waiting for payment...</span>
            </div>

            {/* Bone "Pay via UPI app" Button */}
            {upiUrl && (
              <a
                href={upiUrl}
                className="btn primary"
                style={{
                  width: '100%',
                  height: 44,
                  fontSize: 13,
                  textDecoration: 'none',
                  boxSizing: 'border-box',
                }}
              >
                <Smartphone size={16} strokeWidth={1.5} />
                <span>Pay via UPI app</span>
              </a>
            )}
          </div>
        )}
      </div>

      {/* "Powered by" Footer with AV Mark */}
      <div
        style={{
          marginTop: 24,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 11,
          color: 'var(--muted)',
        }}
      >
        <span>Powered by</span>
        <AvMark size={14} color="var(--muted)" />
        <span style={{ fontFamily: 'var(--font-brand)', letterSpacing: '0.1em' }}>AVENTAS PAY</span>
      </div>

      {/* LIVE SUPPORT CHAT MODAL (Clean Neutral Bubbles) */}
      {showChat && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: 16,
          }}
          onClick={() => setShowChat(false)}
        >
          <div
            style={{
              width: 440,
              maxWidth: '100%',
              height: 520,
              background: 'var(--surface, #111113)',
              border: '1px solid var(--border, #27272A)',
              borderRadius: 14,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              boxShadow: 'var(--shadow-drawer)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Chat Modal Header */}
            <div
              style={{
                padding: '16px 20px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--raised)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 14, fontWeight: 700, color: 'var(--bone)' }}>
                  Support &amp; Verification
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  Order: {order?.paymentId}
                </div>
              </div>
              <button
                onClick={() => setShowChat(false)}
                className="btn ghost sm"
                style={{ width: 28, height: 28, padding: 0 }}
              >
                <X size={15} />
              </button>
            </div>

            {/* Pinned System Status Banner */}
            <div
              style={{
                padding: '9px 14px',
                background: 'var(--raised)',
                borderBottom: '1px solid var(--border-subtle)',
                textAlign: 'center',
                fontSize: 11,
                color: 'var(--muted)',
                lineHeight: 1.45,
              }}
            >
              Support ticket initiated. Please tell us your payment details or UTR number below.
            </div>

            {/* Chat Message Stream */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '24px 16px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              {chatMessages.filter((m) => m.sender !== 'system').length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12, margin: 'auto' }}>
                  No messages yet. Send your 12-digit UPI UTR to verify your payment.
                </div>
              ) : (
                chatMessages
                  .filter((m) => m.sender !== 'system')
                  .map((m) => {
                    const isCustomer = m.sender === 'customer';

                    return (
                      <div
                        key={m.id}
                        className="motion-chat-bubble"
                        style={{
                          alignSelf: isCustomer ? 'flex-end' : 'flex-start',
                          maxWidth: '82%',
                        }}
                      >
                        <div
                          style={{
                            fontSize: 10,
                            color: 'var(--muted)',
                            marginBottom: 3,
                            textAlign: isCustomer ? 'right' : 'left',
                          }}
                        >
                          {isCustomer ? 'You' : 'Aventas Support'}
                        </div>
                        <div
                          style={{
                            padding: '10px 14px',
                            borderRadius: 10,
                            fontSize: 12.5,
                            lineHeight: 1.45,
                            // Neutral tones: user = bone on dark/raised, support = neutral raised surface
                            background: isCustomer ? 'var(--bone)' : 'var(--raised)',
                            color: isCustomer ? 'var(--bg)' : 'var(--bone)',
                            border: isCustomer ? '1px solid var(--bone)' : '1px solid var(--border)',
                            fontWeight: isCustomer ? 500 : 400,
                          }}
                        >
                          {m.message}
                        </div>
                        {m.createdAt && (
                          <div
                            className="mono"
                            style={{
                              fontSize: 9.5,
                              color: 'var(--muted)',
                              marginTop: 3,
                              textAlign: isCustomer ? 'right' : 'left',
                            }}
                          >
                            {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        )}
                      </div>
                    );
                  })
              )}
              {sendingMsg && (
                <div style={{ alignSelf: 'flex-end', maxWidth: '82%' }}>
                  <div
                    className="motion-chat-bubble"
                    style={{
                      padding: '6px 12px',
                      borderRadius: 8,
                      background: 'var(--raised)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    <div className="motion-typing-indicator" style={{ padding: 2 }}>
                      <i /><i /><i />
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Chat Input */}
            <form
              onSubmit={handleSendMessage}
              style={{
                padding: '12px 16px',
                borderTop: '1px solid var(--border)',
                background: 'var(--surface)',
                display: 'flex',
                gap: 8,
              }}
            >
              <input
                type="text"
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                placeholder="Type your message or paste UTR..."
                style={{
                  flex: 1,
                  height: 38,
                  padding: '0 12px',
                  background: 'var(--raised)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: 12.5,
                  color: 'var(--bone)',
                  outline: 'none',
                }}
              />
              <button
                type="submit"
                disabled={sendingMsg || !messageInput.trim()}
                style={{
                  height: 38,
                  padding: '0 14px',
                  borderRadius: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: messageInput.trim() ? 'var(--bone)' : 'var(--raised)',
                  color: messageInput.trim() ? 'var(--bg)' : 'var(--muted)',
                  border: messageInput.trim() ? '1px solid var(--bone)' : '1px solid var(--border)',
                  cursor: messageInput.trim() ? 'pointer' : 'not-allowed',
                  opacity: messageInput.trim() ? 1 : 0.45,
                  transition: 'all 0.15s ease',
                }}
              >
                <Send size={14} strokeWidth={1.5} />
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
