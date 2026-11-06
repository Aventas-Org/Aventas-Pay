import { useState, useEffect, useMemo } from 'react';
import {
  Package, Plus, Copy, Check, Code2, Trash2,
  Sparkles, Layers, IndianRupee, Eye, ArrowUpRight, X
} from 'lucide-react';
import { TopBar, PageHead, StatCard, Badge, EmptyState, Copyable, useToast, Tabs } from '../components/ui.jsx';
import { inr } from '../data.js';

export default function Products() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState('All');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [embedModalProduct, setEmbedModalProduct] = useState(null);
  const [productToDelete, setProductToDelete] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [copiedKey, setCopiedKey] = useState(null);
  const { showToast } = useToast();

  // Form state
  const [name, setName] = useState('');
  const [baseAmount, setBaseAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('Digital Goods');
  const [customId, setCustomId] = useState('');
  const [redirectUrl, setRedirectUrl] = useState('');
  const [createError, setCreateError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Embed tab state in modal
  const [embedType, setEmbedType] = useState('iframe'); // 'iframe' | 'button' | 'link' | 'js'

  const getAdminKey = () => localStorage.getItem('aventas_admin_key') || '';

  const loadProducts = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/products');
      if (res.ok) {
        const data = await res.json();
        setProducts(data);
      }
    } catch (e) {
      console.warn('Failed to load products from API:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProducts();
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreateError('');
    const amt = parseFloat(baseAmount);
    if (!name.trim()) {
      setCreateError('Product name is required');
      return;
    }
    if (isNaN(amt) || amt <= 0) {
      setCreateError('Base amount must be greater than ₹0');
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        name: name.trim(),
        baseAmount: amt,
        description: description.trim(),
        category,
        currency: 'INR',
        redirectUrl: redirectUrl.trim() || '',
      };
      if (customId.trim()) {
        payload.id = customId.trim();
      }

      const res = await fetch('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': getAdminKey() },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to create product');
      }

      const created = await res.json();
      setProducts((prev) => [created, ...prev]);
      setShowCreateModal(false);
      setName('');
      setBaseAmount('');
      setDescription('');
      setCustomId('');
      setRedirectUrl('');
      showToast('Product created successfully');
    } catch (err) {
      setCreateError(err.message || 'Error creating product');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = (prod, e) => {
    e.stopPropagation();
    setProductToDelete(prod);
  };

  const confirmDeleteProduct = async () => {
    if (!productToDelete) return;
    setIsDeleting(true);
    try {
      const res = await fetch(`/api/products/${productToDelete.id}`, {
        method: 'DELETE',
        headers: { 'x-admin-key': getAdminKey() },
      });
      if (res.ok) {
        setProducts((prev) => prev.filter((p) => p.id !== productToDelete.id));
        if (embedModalProduct?.id === productToDelete.id) setEmbedModalProduct(null);
        showToast(`Product "${productToDelete.name}" deleted`);
        setProductToDelete(null);
      } else {
        showToast('Failed to delete product', 'bad');
      }
    } catch (err) {
      console.error('Delete failed:', err);
      showToast('Error deleting product', 'bad');
    } finally {
      setIsDeleting(false);
    }
  };

  const copyToClipboard = (text, key) => {
    navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    showToast('Copied snippet to clipboard');
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const filtered = useMemo(() => {
    return products.filter((p) => {
      const matchSearch =
        !search ||
        p.name.toLowerCase().includes(search.toLowerCase()) ||
        p.id.toLowerCase().includes(search.toLowerCase()) ||
        (p.description && p.description.toLowerCase().includes(search.toLowerCase()));
      const matchTab = activeTab === 'All' || p.category === activeTab;
      return matchSearch && matchTab;
    });
  }, [products, search, activeTab]);

  const origin = import.meta.env.VITE_PUBLIC_BASE_URL || window.location.origin;
  const categories = ['All', ...new Set(products.map((p) => p.category).filter(Boolean))];

  return (
    <>
      <TopBar placeholder="Search products by name, ID or description…" onSearch={setSearch} />
      <div className="content">
        <div className="page">
          <PageHead
            title="Products &amp; Embeds"
            desc="Manage products, configure base prices, and generate embeddable checkout widgets or direct payment links."
          >
            <button className="btn primary" onClick={() => setShowCreateModal(true)}>
              <Plus size={14} /> Create Product
            </button>
          </PageHead>

          <div className="stat-grid">
            <StatCard
              icon={Package}
              label="Total Products"
              value={products.length}
              foot={`${products.filter((p) => p.active !== false).length} active`}
            />
            <StatCard
              icon={IndianRupee}
              label="Lowest Base Price"
              value={products.length ? inr(Math.min(...products.map((p) => p.baseAmount))) : '₹0'}
              foot="Slice UPI verified"
            />
            <StatCard
              icon={Layers}
              label="Categories"
              value={new Set(products.map((p) => p.category).filter(Boolean)).size || 1}
              foot="Segmented catalog"
            />
            <StatCard
              icon={Sparkles}
              label="Decimal Offsets"
              value="₹0.01 – ₹0.49"
              foot="Collision-free pairing"
            />
          </div>

          {/* Category Tabs */}
          <div style={{ marginBottom: 16 }}>
            <Tabs
              value={activeTab}
              onChange={setActiveTab}
              tabs={categories.map((c) => ({
                key: c,
                label: c,
                count: c === 'All' ? products.length : products.filter((p) => p.category === c).length,
              }))}
            />
          </div>

          {/* Products Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 14 }}>
            {filtered.map((prod) => {
              const payUrl = `${origin}/pay/${prod.id}`;

              return (
                <div key={prod.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--bone)', lineHeight: 1.3 }}>{prod.name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
                        {prod.category && <Badge tone="status-review">{prod.category}</Badge>}
                        <span className="mono muted" style={{ fontSize: 11, wordBreak: 'break-all' }}>{prod.id}</span>
                      </div>
                    </div>
                    <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: 'var(--bone)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                      {inr(prod.baseAmount)}
                    </div>
                  </div>

                  <p className="muted" style={{ fontSize: 12, minHeight: 34, lineHeight: 1.4 }}>
                    {prod.description || 'No description provided.'}
                  </p>

                  <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', fontSize: 11 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <span className="muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        Customer Pay Link
                      </span>
                      <button
                        className="link"
                        style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}
                        onClick={() => copyToClipboard(payUrl, `link_${prod.id}`)}
                      >
                        {copiedKey === `link_${prod.id}` ? (
                          <>
                            <Check size={12} color="var(--ok)" /> Copied!
                          </>
                        ) : (
                          <>
                            <Copy size={12} /> Copy URL
                          </>
                        )}
                      </button>
                    </div>
                    <div className="mono" style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--bone)' }}>
                      {payUrl}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, marginTop: 'auto', paddingTop: 8 }}>
                    <button
                      className="btn primary"
                      style={{ flex: 1, justifyContent: 'center' }}
                      onClick={() => setEmbedModalProduct(prod)}
                    >
                      <Code2 size={13} /> Embed Code
                    </button>
                    <button
                      className="btn ghost"
                      title="Test Checkout Experience"
                      onClick={() => window.open(payUrl, '_blank')}
                    >
                      <Eye size={13} /> Test
                    </button>
                    <button
                      className="btn danger"
                      title="Delete Product"
                      onClick={(e) => handleDelete(prod, e)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {filtered.length === 0 && !loading && (
            <div className="card" style={{ padding: 40 }}>
              <EmptyState
                icon={Package}
                title="No products found"
                description="Create your first product to generate embeddable checkout widgets for your site."
                action={
                  <button className="btn primary" onClick={() => setShowCreateModal(true)}>
                    <Plus size={14} /> Create Product
                  </button>
                }
              />
            </div>
          )}
        </div>
      </div>

      {/* CREATE PRODUCT MODAL */}
      {showCreateModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 999,
            padding: 20,
          }}
          onClick={() => setShowCreateModal(false)}
        >
          <div
            className="card"
            style={{ width: 440, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="card-head">
              <div className="card-title">Create New Product</div>
              <button className="link" onClick={() => setShowCreateModal(false)} style={{ padding: 4, cursor: 'pointer' }}>
                <X size={16} />
              </button>
            </div>

            {createError && (
              <div
                style={{
                  background: 'rgba(239, 68, 68, 0.15)',
                  color: 'var(--bad)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  padding: '8px 12px',
                  borderRadius: 8,
                  marginBottom: 12,
                  fontSize: 11.5,
                }}
              >
                {createError}
              </div>
            )}

            <form onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label className="form-label">Product Name *</label>
                <div className="field">
                  <input
                    type="text"
                    required
                    placeholder="e.g. Pro Membership or Test Item"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label className="form-label">Base Amount (INR ₹) *</label>
                  <div className="field">
                    <input
                      type="number"
                      step="any"
                      min="1"
                      required
                      placeholder="e.g. 1"
                      value={baseAmount}
                      onChange={(e) => setBaseAmount(e.target.value)}
                      style={{ width: '100%' }}
                    />
                  </div>
                </div>
                <div>
                  <label className="form-label">Category</label>
                  <div className="field">
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      style={{ width: '100%' }}
                    >
                      <option value="Digital Goods">Digital Goods</option>
                      <option value="Gaming">Gaming</option>
                      <option value="Subscriptions">Subscriptions</option>
                      <option value="Services">Services</option>
                      <option value="Test &amp; QA">Test &amp; QA</option>
                    </select>
                  </div>
                </div>
              </div>

              <div>
                <label className="form-label">Description (Optional)</label>
                <div className="field" style={{ alignItems: 'flex-start' }}>
                  <textarea
                    rows={3}
                    placeholder="Brief description displayed on the checkout screen..."
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    style={{
                      width: '100%',
                      background: 'none',
                      border: 0,
                      outline: 0,
                      color: 'inherit',
                      resize: 'none',
                      fontSize: 12,
                    }}
                  />
                </div>
              </div>

              <div>
                <label className="form-label">Custom Product ID / Slug (Optional)</label>
                <div className="field">
                  <input
                    type="text"
                    placeholder="e.g. test_slice_1rs (auto-generated if empty)"
                    value={customId}
                    onChange={(e) => setCustomId(e.target.value)}
                    style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                  />
                </div>
              </div>

              <div>
                <label className="form-label">Custom Redirect URL (Optional)</label>
                <div className="field">
                  <input
                    type="url"
                    placeholder="https://yoursite.com/thank-you"
                    value={redirectUrl}
                    onChange={(e) => setRedirectUrl(e.target.value)}
                    style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                  />
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                  Redirects the customer or parent window automatically after successful payment
                </div>
              </div>

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 12 }}>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setShowCreateModal(false)}
                >
                  <X size={13} /> Cancel
                </button>
                <button
                  type="submit"
                  className="btn primary lg"
                  style={{ fontWeight: 700 }}
                  disabled={isSubmitting}
                >
                  <Plus size={14} /> {isSubmitting ? 'Creating...' : 'Create & Generate Embed'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EMBED & INTEGRATION MODAL */}
      {embedModalProduct && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 999,
            padding: 20,
          }}
          onClick={() => setEmbedModalProduct(null)}
        >
          <div
            className="card"
            style={{ width: 620, maxWidth: '100%', maxHeight: '92vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="card-head">
              <div>
                <div className="card-title">Embed &amp; Integration: {embedModalProduct.name}</div>
                <div className="card-sub mono">
                  Base Price: {inr(embedModalProduct.baseAmount)} · ID: {embedModalProduct.id}
                </div>
              </div>
              <button className="link" onClick={() => setEmbedModalProduct(null)} style={{ padding: 4, cursor: 'pointer' }}>
                <X size={16} />
              </button>
            </div>

            {/* Navigation Tabs */}
            <div className="tabs" style={{ marginBottom: 14 }}>
              <button
                className={`tab ${embedType === 'iframe' ? 'active' : ''}`}
                onClick={() => setEmbedType('iframe')}
              >
                IFrame Embed
              </button>
              <button
                className={`tab ${embedType === 'button' ? 'active' : ''}`}
                onClick={() => setEmbedType('button')}
              >
                Buy Button (Popup)
              </button>
              <button
                className={`tab ${embedType === 'link' ? 'active' : ''}`}
                onClick={() => setEmbedType('link')}
              >
                Direct Link
              </button>
              <button
                className={`tab ${embedType === 'js' ? 'active' : ''}`}
                onClick={() => setEmbedType('js')}
              >
                JavaScript Listener
              </button>
            </div>

            {/* Tab 1: IFrame Embed */}
            {embedType === 'iframe' && (
              <div>
                <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                  Embed the self-updating UPI QR code and payment verification widget directly inside any webpage:
                </p>
                <div style={{ position: 'relative' }}>
                  <pre
                    style={{
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      padding: '12px 14px',
                      borderRadius: 8,
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      overflowX: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      color: 'var(--bone)',
                    }}
                  >{`<iframe
  src="${origin}/embed/${embedModalProduct.id}"
  width="420"
  height="640"
  style="border: none; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); overflow: hidden;"
  allow="clipboard-write"
></iframe>`}</pre>
                  <button
                    className="btn primary"
                    style={{ position: 'absolute', top: 8, right: 8, fontSize: 11 }}
                    onClick={() =>
                      copyToClipboard(
                        `<iframe\n  src="${origin}/embed/${embedModalProduct.id}"\n  width="420"\n  height="640"\n  style="border: none; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); overflow: hidden;"\n  allow="clipboard-write"\n></iframe>`,
                        'code_iframe'
                      )
                    }
                  >
                    {copiedKey === 'code_iframe' ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === 'code_iframe' ? 'Copied!' : 'Copy Code'}
                  </button>
                </div>
              </div>
            )}

            {/* Tab 2: Buy Button */}
            {embedType === 'button' && (
              <div>
                <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                  Copy this button snippet into your website. When clicked, it opens the checkout modal window:
                </p>
                <div style={{ position: 'relative' }}>
                  <pre
                    style={{
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      padding: '12px 14px',
                      borderRadius: 8,
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      overflowX: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      color: 'var(--bone)',
                    }}
                  >{`<!-- AventasPay Checkout Button -->
<button
  onclick="window.open('${origin}/pay/${embedModalProduct.id}', 'AventasCheckout', 'width=460,height=720,scrollbars=yes')"
  style="background: #E9E6DF; color: #0A0A0B; border: 1px solid rgba(255,255,255,0.2); padding: 12px 22px; border-radius: 8px; font-weight: 600; font-size: 14px; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-family: system-ui, sans-serif;"
>
  Pay ₹${embedModalProduct.baseAmount} via UPI
</button>`}</pre>
                  <button
                    className="btn primary"
                    style={{ position: 'absolute', top: 8, right: 8, fontSize: 11 }}
                    onClick={() =>
                      copyToClipboard(
                        `<button\n  onclick="window.open('${origin}/pay/${embedModalProduct.id}', 'AventasCheckout', 'width=460,height=720,scrollbars=yes')"\n  style="background: #E9E6DF; color: #0A0A0B; border: 1px solid rgba(255,255,255,0.2); padding: 12px 22px; border-radius: 8px; font-weight: 600; font-size: 14px; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; font-family: system-ui, sans-serif;"\n>\n  Pay ₹${embedModalProduct.baseAmount} via UPI\n</button>`,
                        'code_btn'
                      )
                    }
                  >
                    {copiedKey === 'code_btn' ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === 'code_btn' ? 'Copied!' : 'Copy Snippet'}
                  </button>
                </div>
              </div>
            )}

            {/* Tab 3: Direct Link */}
            {embedType === 'link' && (
              <div>
                <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                  Share this direct link with customers via Discord, WhatsApp, Telegram, or email:
                </p>
                <div style={{ position: 'relative' }}>
                  <pre
                    style={{
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      padding: '12px 14px',
                      borderRadius: 8,
                      fontSize: 12,
                      fontFamily: 'var(--font-mono)',
                      overflowX: 'auto',
                      color: 'var(--bone)',
                    }}
                  >{`${origin}/pay/${embedModalProduct.id}`}</pre>
                  <button
                    className="btn primary"
                    style={{ position: 'absolute', top: 8, right: 8, fontSize: 11 }}
                    onClick={() =>
                      copyToClipboard(`${origin}/pay/${embedModalProduct.id}`, 'code_link')
                    }
                  >
                    {copiedKey === 'code_link' ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === 'code_link' ? 'Copied!' : 'Copy Link'}
                  </button>
                </div>
                <div style={{ marginTop: 12 }}>
                  <button
                    className="btn ghost"
                    onClick={() => window.open(`${origin}/pay/${embedModalProduct.id}`, '_blank')}
                  >
                    <ArrowUpRight size={13} /> Open Checkout in New Tab
                  </button>
                </div>
              </div>
            )}

            {/* Tab 4: JS Listener */}
            {embedType === 'js' && (
              <div>
                <p className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
                  Listen for the <code style={{ color: 'var(--ok)' }}>aventas:paid</code> event on your site when payment is confirmed:
                </p>
                <div style={{ position: 'relative' }}>
                  <pre
                    style={{
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      padding: '12px 14px',
                      borderRadius: 8,
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      overflowX: 'auto',
                      color: 'var(--bone)',
                    }}
                  >{`<script>
  window.addEventListener('message', (event) => {
    if (event.data && event.data.event === 'aventas:paid') {
      console.log('Payment Confirmed!', event.data.orderId, event.data.utr);
      // Fulfill order, unlock digital download, or redirect customer
      alert('Thank you! Payment verified: ' + event.data.orderId);
      window.location.href = '/thank-you?order=' + event.data.orderId;
    }
  });
</script>`}</pre>
                  <button
                    className="btn primary"
                    style={{ position: 'absolute', top: 8, right: 8, fontSize: 11 }}
                    onClick={() =>
                      copyToClipboard(
                        `<script>\n  window.addEventListener('message', (event) => {\n    if (event.data && event.data.event === 'aventas:paid') {\n      console.log('Payment Confirmed!', event.data.orderId, event.data.utr);\n      alert('Thank you! Payment verified: ' + event.data.orderId);\n      window.location.href = '/thank-you?order=' + event.data.orderId;\n    }\n  });\n</script>`,
                        'code_js'
                      )
                    }
                  >
                    {copiedKey === 'code_js' ? <Check size={12} /> : <Copy size={12} />}
                    {copiedKey === 'code_js' ? 'Copied!' : 'Copy Script'}
                  </button>
                </div>
              </div>
            )}

            {/* Live Interactive Preview */}
            <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--bone)' }}>Interactive Preview</span>
                <span className="mono muted" style={{ fontSize: 11 }}>Widget Dimensions: 420px × 560px</span>
              </div>
              <div
                style={{
                  background: 'var(--bg)',
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  padding: 12,
                  display: 'flex',
                  justifyContent: 'center',
                }}
              >
                <iframe
                  src={`${origin}/embed/${embedModalProduct.id}`}
                  style={{
                    width: 420,
                    height: 520,
                    border: 'none',
                    borderRadius: 12,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                    background: '#0a0a0b',
                  }}
                  title="AventasPay Live Preview"
                />
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setEmbedModalProduct(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DELETE PRODUCT CONFIRMATION MODAL */}
      {productToDelete && (
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
            padding: 20,
          }}
          onClick={() => setProductToDelete(null)}
        >
          <div
            className="card"
            style={{ width: 440, maxWidth: '100%', borderColor: 'var(--bad-border)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--bad)', marginBottom: 12 }}>
              <Trash2 size={20} />
              <div style={{ fontSize: 16, fontWeight: 700 }}>Delete Product</div>
            </div>
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 18 }}>
              Are you sure you want to delete <strong style={{ color: 'var(--bone)' }}>{productToDelete.name}</strong> ({productToDelete.id})? This action cannot be undone. Active checkout sessions referencing this product will be invalidated.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                className="btn ghost"
                onClick={() => setProductToDelete(null)}
                disabled={isDeleting}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={confirmDeleteProduct}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Delete Product'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}