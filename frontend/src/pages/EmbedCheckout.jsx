import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import AnimatedQr from '../components/AnimatedQr';
import {
  Clock, AlertTriangle, Smartphone, RefreshCw, MessageCircle, Send, X, ArrowRight
} from 'lucide-react';
import { AvMark, HazardStripe } from '../components/AvLogo.jsx';
import { inr } from '../data.js';

// Only follow https (or localhost) return URLs, never example.com / empty placeholders
function isValidReturnUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed.includes('example.com') || trimmed.includes('placeholder')) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

export default function EmbedCheckout() {
  const { productId } = useParams();
  const navigate = useNavigate();

  const [product, setProduct] = useState(null);
  const [order, setOrder] = useState(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [upiUrl, setUpiUrl] = useState('');
  const [status, setStatus] = useState('loading'); // loading, pending, success, expired, error
  const [timeLeft, setTimeLeft] = useState(600);
  const [totalTime, setTotalTime] = useState(600);
  const [confirmData, setConfirmData] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');

  // Support & Live Chat Drawer state
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [messageInput, setMessageInput] = useState('');
  const [sendingMsg, setSendingMsg] = useState(false);

  const timerRef = useRef(null);
  const pollRef = useRef(null);
  const chatPollRef = useRef(null);
  const chatEndRef = useRef(null);
  const currentPaymentIdRef = useRef(null);

  useEffect(() => {
    let isCancelled = false;

    // Avoid re-fetching if we just updated the route to this paymentId
    if (currentPaymentIdRef.current && currentPaymentIdRef.current === productId) {
      return;
    }

    async function initEmbedCheckout() {
      try {
        setStatus('loading');

        // Check if param is an existing payment/order ID (e.g. pay_... or ORD-...)
        const isExistingOrder = Boolean(
          productId && (productId.startsWith('pay_') || productId.startsWith('ORD-'))
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

          // Compute remaining seconds from order expiresAt
          const expiryMs = new Date(orderData.expiresAt).getTime();
          const remainingSecs = Math.max(0, Math.floor((expiryMs - Date.now()) / 1000));
          setTimeLeft(remainingSecs);
          setTotalTime(Math.max(600, remainingSecs));

          // If already completed
          if (orderData.status === 'SUCCESS' || orderData.status === 'PAID') {
            setStatus('success');
            setConfirmData(orderData);
            return;
          }

          // If expired
          if (orderData.status === 'EXPIRED' || remainingSecs <= 0) {
            setStatus('expired');
            return;
          }

          // Build UPI URI for existing order
          // The server builds this from the UPI ID configured in Settings.
          const upi = orderData.upiIntent;
          if (!upi) throw new Error('Payment is not available for this order');
          setUpiUrl(upi);

          const qrUrl = await QRCode.toDataURL(upi, {
            width: 280,
            margin: 1.5,
            errorCorrectionLevel: 'H',
            color: {
              dark: '#000000',
              light: '#ffffff',
            },
          });

          if (isCancelled) return;
          setQrDataUrl(qrUrl);
          setStatus('pending');
          return;
        }

        // Otherwise it's a product: fetch product and create order
        let prodInfo = {
          id: productId || 'product_direct',
          name: 'Direct UPI Payment',
          description: 'Instant UPI Checkout',
          baseAmount: 1,
        };

        try {
          const pRes = await fetch(`/api/products/${productId}`);
          if (pRes.ok) {
            prodInfo = await pRes.json();
          }
        } catch (e) {
          console.warn('Embed checkout using default product info:', e);
        }

        if (isCancelled) return;
        setProduct(prodInfo);

        // Create Order via /api/payments/create
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

        // Build UPI URI
        const upi = orderData.upiIntent;
        if (!upi) throw new Error('Payment is not available for this order');
        setUpiUrl(upi);

        // Generate QR Code with High error correction for center logo placement
        const qrUrl = await QRCode.toDataURL(upi, {
          width: 280,
          margin: 1.5,
          errorCorrectionLevel: 'H',
          color: {
            dark: '#000000',
            light: '#ffffff',
          },
        });

        if (isCancelled) return;
        setQrDataUrl(qrUrl);
        setStatus('pending');

        // Immediately update URL in address bar to /embed/:paymentId so on refresh we resume this exact session
        navigate(`/embed/${orderData.paymentId}`, { replace: true });
      } catch (err) {
        if (!isCancelled) {
          setStatus('error');
          setErrorMessage(err.message || 'Payment initialization error');
        }
      }
    }

    initEmbedCheckout();
    return () => {
      isCancelled = true;
    };
  }, [productId, navigate]);

  // Timer countdown (10 mins)
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

  // Real-time poller (2s interval, polls during pending and also while chat is open)
  useEffect(() => {
    if ((status !== 'pending' && !showChat) || !order) return;

    const checkStatus = async () => {
      try {
        const res = await fetch(`/api/payments/${order.paymentId}`);
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'SUCCESS' || data.status === 'PAID') {
            setStatus('success');
            setConfirmData(data);
            clearInterval(pollRef.current);

            const rawRedirect = order.redirectUrl || product?.redirectUrl || data.redirectUrl;
            const targetRedirect = isValidReturnUrl(rawRedirect) ? rawRedirect : null;

            // Notify parent window via postMessage
            if (window.parent) {
              window.parent.postMessage(
                {
                  event: 'aventas:paid',
                  type: 'AVENTAS_PAYMENT_SUCCESS',
                  orderId: order.paymentId,
                  paymentId: order.paymentId,
                  amount: order.amount,
                  utr: data.rrn || 'verified',
                  redirectUrl: targetRedirect || '',
                  timestamp: Date.now(),
                },
                '*'
              );
            }

            if (targetRedirect) {
              setTimeout(() => {
                try {
                  if (window.top && window.top !== window) {
                    window.top.location.href = targetRedirect;
                  } else {
                    window.location.href = targetRedirect;
                  }
                } catch {
                  window.location.href = targetRedirect;
                }
              }, 2500);
            }
            return;
          }
        }
      } catch (err) {
        console.warn('Embed poll error:', err);
      }
    };

    pollRef.current = setInterval(checkStatus, 2000);
    return () => clearInterval(pollRef.current);
  }, [status, order, showChat]);

  // Live Chat Poller
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
        console.warn('Embed chat poll error:', e);
      }
    };

    fetchMessages();
    chatPollRef.current = setInterval(fetchMessages, 2000);
    return () => clearInterval(chatPollRef.current);
  }, [showChat, order]);

  useEffect(() => {
    if (showChat) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
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
          customerName: 'Embed Customer',
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

  const formatTime = (secs) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const pct = Math.max(0, Math.min(100, (timeLeft / (totalTime || 600)) * 100));
  const critical = timeLeft < 60;
  const amountText = order ? inr(order.amount) : product ? inr(product.baseAmount) : inr(0);
  const returnUrl = [order?.redirectUrl, product?.redirectUrl, confirmData?.redirectUrl].find(isValidReturnUrl);

  const bubbleBase = { padding: '8px 12px', borderRadius: 10, fontSize: 12, lineHeight: 1.45 };

  return (
    <div
      style={{
        width: '100%',
        minHeight: '100vh',
        background: 'var(--bg, #0A0A0B)',
        color: 'var(--bone, #E9E6DF)',
        fontFamily: 'var(--font-body)',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        padding: 12,
        position: 'relative',
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        <HazardStripe height={4} />

        {/* Header: product + exact amount */}
        <div
          style={{
            padding: '14px 18px',
            background: 'var(--raised)',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              Pay to <strong style={{ color: 'var(--bone)' }}>AventasPay</strong>
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 14.5, fontWeight: 700, marginTop: 2 }}>
              {product?.name || 'UPI Checkout'}
            </div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {order?.paymentId || 'Initializing...'}
            </div>
          </div>
          <div className="mono" style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
            {amountText}
          </div>
        </div>

        {status === 'loading' && (
          <div style={{ padding: 40, textAlign: 'center', margin: 'auto' }}>
            <RefreshCw size={24} className="spin" style={{ margin: '0 auto 10px', color: 'var(--accent)' }} />
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>Preparing checkout...</div>
          </div>
        )}

        {status === 'error' && (
          <div style={{ padding: 28, textAlign: 'center', margin: 'auto' }}>
            <AlertTriangle size={30} style={{ margin: '0 auto 8px', color: 'var(--bad)' }} />
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--bad)' }}>Checkout error</div>
            <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 14px' }}>{errorMessage}</p>
            <button onClick={() => window.location.reload()} className="btn secondary sm">Retry</button>
          </div>
        )}

        {status === 'expired' && (
          <div style={{ padding: 24, textAlign: 'center', margin: 'auto', width: '100%' }}>
            <div className="motion-expired-clock"><Clock size={24} strokeWidth={1.5} /></div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 15, fontWeight: 700 }}>Payment window expired</div>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '8px auto 16px', lineHeight: 1.5, maxWidth: 290 }}>
              You haven&apos;t paid yet. If money was debited, contact support and we&apos;ll verify it.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={openChatSupport} className="btn primary" style={{ width: '100%' }}>
                <MessageCircle size={14} strokeWidth={1.5} /> Contact support
              </button>
              <button
                onClick={() => {
                  navigate('/embed/test_slice_1rs');
                  window.location.reload();
                }}
                className="btn secondary"
                style={{ width: '100%' }}
              >
                <RefreshCw size={13} strokeWidth={1.5} /> Create new payment
              </button>
            </div>
          </div>
        )}

        {status === 'success' && (
          <div style={{ padding: '22px 20px', textAlign: 'center', margin: 'auto', width: '100%' }}>
            <div className="motion-success-mark" style={{ marginBottom: 10 }}>
              <svg viewBox="0 0 80 80">
                <circle className="motion-success-ring" pathLength="1" cx="40" cy="40" r="34" />
                <path className="motion-success-tick" pathLength="1" d="M26 41l10 10 19-21" />
              </svg>
              {Array.from({ length: 16 }, (_, i) => {
                const a = (i / 16) * Math.PI * 2;
                const d = 52 + (i % 3) * 12;
                return (
                  <i key={i} className="motion-particle" style={{ '--tx': `${(Math.cos(a) * d).toFixed(1)}px`, '--ty': `${(Math.sin(a) * d).toFixed(1)}px` }} />
                );
              })}
            </div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700 }}>Payment confirmed</div>
            <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '4px 0 16px' }}>Your order is complete.</p>
            <div
              style={{
                background: 'var(--raised)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '12px 14px',
                fontSize: 11.5,
                textAlign: 'left',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--muted)' }}>Amount</span>
                <span className="mono" style={{ fontWeight: 700 }}>{inr(order?.amount || confirmData?.amount)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ color: 'var(--muted)' }}>Order ID</span>
                <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{order?.paymentId}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--muted)' }}>Reference (RRN)</span>
                <span className="mono" style={{ fontWeight: 600 }}>{confirmData?.rrn || confirmData?.provider_transaction_ref || 'Verified'}</span>
              </div>
            </div>
            {returnUrl && (
              <button
                onClick={() => {
                  try {
                    if (window.top && window.top !== window) window.top.location.href = returnUrl;
                    else window.location.href = returnUrl;
                  } catch {
                    window.location.href = returnUrl;
                  }
                }}
                className="btn primary"
                style={{ marginTop: 12, width: '100%' }}
              >
                <span>Continue to merchant</span>
                <ArrowRight size={14} strokeWidth={1.5} />
              </button>
            )}
          </div>
        )}

        {status === 'pending' && (
          <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14, flex: 1 }}>
            {/* Countdown */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Clock size={12} strokeWidth={1.5} /> Time remaining
                </span>
                <span className={`mono motion-countdown-digits ${critical ? 'critical' : ''}`} style={{ color: critical ? 'var(--bad)' : 'var(--warn)', fontWeight: 600 }}>
                  {formatTime(timeLeft)}
                </span>
              </div>
              <div className={`motion-countdown-bar ${critical ? 'critical' : ''}`}><i style={{ width: `${pct}%` }} /></div>
            </div>

            {/* QR */}
            <div
              className="motion-qr-wrap"
              style={{
                background: '#ffffff',
                padding: 10,
                margin: '0 auto',
                width: 210,
                height: 210,
                boxSizing: 'border-box',
                '--qr-h': '210px',
              }}
            >
              <div style={{ position: 'relative', width: 190, height: 190 }}>
                {qrDataUrl && upiUrl && <AnimatedQr text={upiUrl} size={190} />}
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
                  <div style={{ width: 36, height: 36, borderRadius: 8, background: '#ffffff', border: '1.5px solid #E9E6DF', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 4 }}>
                    <AvMark size={22} dark={true} color="#0A0A0B" />
                  </div>
                </div>
              </div>
              <div className="motion-scan-line" />
            </div>

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
              }}
            >
              <span className="motion-pulse-dot pulse" style={{ color: 'var(--warn)' }} />
              <span style={{ fontWeight: 500 }}>Waiting for payment...</span>
            </div>

            {upiUrl && (
              <a href={upiUrl} className="btn primary" style={{ width: '100%', height: 42, textDecoration: 'none' }}>
                <Smartphone size={15} strokeWidth={1.5} /> Pay via UPI app
              </a>
            )}
          </div>
        )}

        {/* Live support chat overlay */}
        {showChat && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'var(--surface)',
              display: 'flex',
              flexDirection: 'column',
              zIndex: 100,
            }}
          >
            <div style={{ padding: '12px 16px', background: 'var(--raised)', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontFamily: 'var(--font-display)', fontSize: 13, fontWeight: 700 }}>Support &amp; Verification</div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>Order: {order?.paymentId}</div>
              </div>
              <button onClick={() => setShowChat(false)} className="btn ghost sm" style={{ width: 28, height: 28, padding: 0 }}>
                <X size={15} />
              </button>
            </div>

            <div style={{ flex: 1, padding: 14, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {chatMessages.length === 0 ? (
                <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 11.5, marginTop: 40 }}>
                  Send your payment details or 12-digit UTR below.
                </div>
              ) : (
                chatMessages.map((msg, i) => {
                  const isCustomer = msg.sender === 'customer';
                  if (msg.sender === 'system') {
                    return (
                      <div key={msg.id || i} style={{ textAlign: 'center', fontSize: 10.5, color: 'var(--muted)', background: 'var(--raised)', border: '1px solid var(--border-subtle)', padding: '6px 10px', borderRadius: 6, lineHeight: 1.4 }}>
                        {msg.message}
                      </div>
                    );
                  }
                  return (
                    <div key={msg.id || i} className="motion-chat-bubble" style={{ alignSelf: isCustomer ? 'flex-end' : 'flex-start', maxWidth: '84%' }}>
                      <div style={{ fontSize: 9.5, color: 'var(--muted)', marginBottom: 2, textAlign: isCustomer ? 'right' : 'left' }}>
                        {isCustomer ? 'You' : 'Aventas Support'}
                      </div>
                      <div
                        style={{
                          ...bubbleBase,
                          background: isCustomer ? 'var(--bone)' : 'var(--raised)',
                          color: isCustomer ? 'var(--bg)' : 'var(--bone)',
                          border: isCustomer ? '1px solid var(--bone)' : '1px solid var(--border)',
                          fontWeight: isCustomer ? 500 : 400,
                        }}
                      >
                        {msg.message}
                      </div>
                    </div>
                  );
                })
              )}
              {sendingMsg && (
                <div style={{ alignSelf: 'flex-end' }}>
                  <div className="motion-chat-bubble" style={{ padding: '6px 12px', borderRadius: 8, background: 'var(--raised)', border: '1px solid var(--border)' }}>
                    <div className="motion-typing-indicator" style={{ padding: 2 }}><i /><i /><i /></div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <form onSubmit={handleSendMessage} style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
              <input
                type="text"
                placeholder="Type message or paste UTR..."
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                style={{ flex: 1, height: 36, padding: '0 12px', fontSize: 12.5, background: 'var(--raised)' }}
              />
              <button
                type="submit"
                disabled={sendingMsg || !messageInput.trim()}
                className="btn primary"
                style={{ height: 36, padding: '0 14px' }}
              >
                <Send size={13} strokeWidth={1.5} />
              </button>
            </form>
          </div>
        )}
      </div>

      <div style={{ textAlign: 'center', fontSize: 10.5, color: 'var(--muted)', marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <span>Secured by</span>
        <AvMark size={12} color="var(--muted)" />
        <span style={{ fontFamily: 'var(--font-brand)', letterSpacing: '0.1em' }}>AVENTAS PAY</span>
      </div>
    </div>
  );
}
