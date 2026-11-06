import { useState, useEffect, useMemo } from 'react';
import { Tabs, TopBar, PageHead, Badge, useToast } from '../components/ui.jsx';
import {
  Check, Mail, Save, KeyRound, Bell, CreditCard,
  Eye, EyeOff, Copy, AlertTriangle, Trash2, RotateCcw
} from 'lucide-react';

function maskSecret(val) {
  if (!val) return '••••••••';
  const str = String(val);
  if (str.length <= 4) return '••••' + str;
  return '•••• •••• •••• ' + str.slice(-4);
}

export default function Settings() {
  const [tab, setTab] = useState('general');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  // Baseline server state for dirty-tracking
  const [initialSettings, setInitialSettings] = useState(null);

  // General Settings state
  const [platformName, setPlatformName] = useState('AventasPay');
  const [supportEmail, setSupportEmail] = useState('support@aventaspay.com');
  const [systemTimezone, setSystemTimezone] = useState('Asia/Kolkata (UTC+05:30)');
  const [settlementCurrency, setSettlementCurrency] = useState('INR (₹)');
  const [paymentTtlMinutes, setPaymentTtlMinutes] = useState('10');

  // Primary Integration state (Slice Bank)
  const [email, setEmail] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pollInterval, setPollInterval] = useState('5');
  const [upiId, setUpiId] = useState('');

  // Notifications state
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [paymentAlerts, setPaymentAlerts] = useState(true);
  const [timeoutAlerts, setTimeoutAlerts] = useState(true);

  // Config: Webhook & Secondary Slice Account (email, pass, upi only)
  const [discordWebhookUrl, setDiscordWebhookUrl] = useState('');
  const [secondaryEmail, setSecondaryEmail] = useState('');
  const [secondaryAppPassword, setSecondaryAppPassword] = useState('');
  const [showSecondaryPassword, setShowSecondaryPassword] = useState(false);
  const [secondaryUpiId, setSecondaryUpiId] = useState('');

  // Admin Secret Key state
  const [currentSecretKey, setCurrentSecretKey] = useState('');
  const [newSecretKey, setNewSecretKey] = useState('');
  const [showNewKey, setShowNewKey] = useState(false);
  const [updatingKey, setUpdatingKey] = useState(false);

  // Clear DB state & VITE_ALLOW_DB_RESET gate
  const allowDbReset = import.meta.env.VITE_ALLOW_DB_RESET === 'true';
  const [clearingDb, setClearingDb] = useState(false);
  const [showClearModal, setShowClearModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteAdminKey, setDeleteAdminKey] = useState('');
  const [clearDbError, setClearDbError] = useState('');

  const getAdminKey = () => localStorage.getItem('aventas_admin_key') || '';

  const loadSettings = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/admin/settings', {
        headers: { 'x-admin-key': getAdminKey() },
      });
      if (res.ok) {
        const data = await res.json();
        const stateObj = {
          email: data.email || '',
          appPassword: data.appPassword || '',
          pollInterval: String(data.pollIntervalSeconds || 5),
          upiId: data.upiId || '',
          platformName: data.platformName || 'AventasPay',
          supportEmail: data.supportEmail || 'support@aventaspay.com',
          systemTimezone: data.systemTimezone || 'Asia/Kolkata (UTC+05:30)',
          settlementCurrency: data.settlementCurrency || 'INR (₹)',
          paymentTtlMinutes: String(data.paymentTtlMinutes || 10),
          discordWebhookUrl: data.discordWebhookUrl || '',
          secondaryEmail: data.secondaryEmail || '',
          secondaryAppPassword: data.secondaryAppPassword || '',
          secondaryUpiId: data.secondaryUpiId || '',
          emailAlerts: data.notificationsEmailAlerts !== undefined ? data.notificationsEmailAlerts : true,
          paymentAlerts: data.notificationsPaymentAlerts !== undefined ? data.notificationsPaymentAlerts : true,
          timeoutAlerts: data.notificationsTimeoutAlerts !== undefined ? data.notificationsTimeoutAlerts : true,
        };

        setEmail(stateObj.email);
        setAppPassword(stateObj.appPassword);
        setPollInterval(stateObj.pollInterval);
        setUpiId(stateObj.upiId);
        setPlatformName(stateObj.platformName);
        setSupportEmail(stateObj.supportEmail);
        setSystemTimezone(stateObj.systemTimezone);
        setSettlementCurrency(stateObj.settlementCurrency);
        setPaymentTtlMinutes(stateObj.paymentTtlMinutes);
        setDiscordWebhookUrl(stateObj.discordWebhookUrl);
        setSecondaryEmail(stateObj.secondaryEmail);
        setSecondaryAppPassword(stateObj.secondaryAppPassword);
        setSecondaryUpiId(stateObj.secondaryUpiId);
        setEmailAlerts(stateObj.emailAlerts);
        setPaymentAlerts(stateObj.paymentAlerts);
        setTimeoutAlerts(stateObj.timeoutAlerts);

        setInitialSettings(stateObj);
      }
    } catch (e) {
      console.warn('Settings load error:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSettings();
  }, []);

  // Compute dirty state
  const isDirty = useMemo(() => {
    if (!initialSettings) return false;
    return (
      email !== initialSettings.email ||
      appPassword !== initialSettings.appPassword ||
      pollInterval !== initialSettings.pollInterval ||
      upiId !== initialSettings.upiId ||
      platformName !== initialSettings.platformName ||
      supportEmail !== initialSettings.supportEmail ||
      systemTimezone !== initialSettings.systemTimezone ||
      settlementCurrency !== initialSettings.settlementCurrency ||
      paymentTtlMinutes !== initialSettings.paymentTtlMinutes ||
      discordWebhookUrl !== initialSettings.discordWebhookUrl ||
      secondaryEmail !== initialSettings.secondaryEmail ||
      secondaryAppPassword !== initialSettings.secondaryAppPassword ||
      secondaryUpiId !== initialSettings.secondaryUpiId ||
      emailAlerts !== initialSettings.emailAlerts ||
      paymentAlerts !== initialSettings.paymentAlerts ||
      timeoutAlerts !== initialSettings.timeoutAlerts
    );
  }, [
    initialSettings, email, appPassword, pollInterval, upiId,
    platformName, supportEmail, systemTimezone, settlementCurrency,
    paymentTtlMinutes, discordWebhookUrl, secondaryEmail,
    secondaryAppPassword, secondaryUpiId, emailAlerts,
    paymentAlerts, timeoutAlerts
  ]);

  const handleDiscard = () => {
    if (!initialSettings) return;
    setEmail(initialSettings.email);
    setAppPassword(initialSettings.appPassword);
    setPollInterval(initialSettings.pollInterval);
    setUpiId(initialSettings.upiId);
    setPlatformName(initialSettings.platformName);
    setSupportEmail(initialSettings.supportEmail);
    setSystemTimezone(initialSettings.systemTimezone);
    setSettlementCurrency(initialSettings.settlementCurrency);
    setPaymentTtlMinutes(initialSettings.paymentTtlMinutes);
    setDiscordWebhookUrl(initialSettings.discordWebhookUrl);
    setSecondaryEmail(initialSettings.secondaryEmail);
    setSecondaryAppPassword(initialSettings.secondaryAppPassword);
    setSecondaryUpiId(initialSettings.secondaryUpiId);
    setEmailAlerts(initialSettings.emailAlerts);
    setPaymentAlerts(initialSettings.paymentAlerts);
    setTimeoutAlerts(initialSettings.timeoutAlerts);
    showToast('Changes discarded');
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      const payload = {
        email,
        appPassword,
        pollIntervalSeconds: parseInt(pollInterval, 10) || 5,
        upiId,
        platformName,
        supportEmail,
        systemTimezone,
        settlementCurrency,
        paymentTtlMinutes: parseInt(paymentTtlMinutes, 10) || 10,
        discordWebhookUrl,
        secondaryEmail,
        secondaryAppPassword,
        secondaryUpiId,
        notificationsEmailAlerts: emailAlerts,
        notificationsPaymentAlerts: paymentAlerts,
        notificationsTimeoutAlerts: timeoutAlerts,
      };

      const res = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': getAdminKey(),
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        showToast('Settings saved and synchronized successfully!');
        setInitialSettings({
          email,
          appPassword,
          pollInterval,
          upiId,
          platformName,
          supportEmail,
          systemTimezone,
          settlementCurrency,
          paymentTtlMinutes,
          discordWebhookUrl,
          secondaryEmail,
          secondaryAppPassword,
          secondaryUpiId,
          emailAlerts,
          paymentAlerts,
          timeoutAlerts,
        });
      } else {
        showToast('Failed to save settings', 'bad');
      }
    } catch (e) {
      showToast('Network error while saving settings', 'bad');
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateSecretKey = async (e) => {
    e.preventDefault();
    const cleanKey = newSecretKey.trim();
    if (!cleanKey || cleanKey.length < 6) {
      showToast('Secret key must be at least 6 characters', 'bad');
      return;
    }

    setUpdatingKey(true);
    try {
      const res = await fetch('/api/admin/settings/secret-key', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': getAdminKey(),
        },
        body: JSON.stringify({ newKey: cleanKey }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        localStorage.setItem('aventas_admin_key', cleanKey);
        setCurrentSecretKey(cleanKey);
        setNewSecretKey('');
        showToast('Admin Secret Key updated successfully!');
      } else {
        showToast(data.error || 'Failed to update secret key', 'bad');
      }
    } catch (e) {
      showToast('Network error while updating secret key', 'bad');
    } finally {
      setUpdatingKey(false);
    }
  };

  const handleClearDatabase = async () => {
    if (deleteConfirmText !== 'DELETE EVERYTHING') {
      setClearDbError('You must type DELETE EVERYTHING to confirm.');
      return;
    }
    if (!deleteAdminKey.trim() || deleteAdminKey.trim() !== getAdminKey()) {
      setClearDbError('Active admin key is incorrect.');
      return;
    }

    setClearingDb(true);
    setClearDbError('');
    try {
      const res = await fetch('/api/admin/database/clear', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-admin-key': deleteAdminKey.trim(),
        },
      });

      if (res.ok) {
        showToast('Database wiped clean. Demo product preserved.');
        setShowClearModal(false);
        setDeleteConfirmText('');
        setDeleteAdminKey('');
      } else {
        const d = await res.json().catch(() => ({}));
        setClearDbError(d.error || 'Failed to clear database');
        showToast('Failed to clear database', 'bad');
      }
    } catch (e) {
      setClearDbError('Error connecting to server');
      showToast('Error connecting to server', 'bad');
    } finally {
      setClearingDb(false);
    }
  };

  return (
    <>
      <TopBar placeholder="Search settings…" />
      <div className="content">
        <div className="page" style={{ paddingBottom: isDirty ? 80 : 24 }}>
          <PageHead
            title="Settings"
            desc="Configure Slice Bank UPI verification, IMAP email listener, system parameters, and universal security."
          >
            <button className="btn primary" onClick={() => handleSaveSettings()} disabled={saving || !isDirty}>
              <Save size={13} /> {saving ? 'Saving...' : 'Save Settings'}
            </button>
          </PageHead>

          {/* Settings Tabs Navigation */}
          <div style={{ marginBottom: 16 }}>
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { key: 'general', label: 'General' },
                { key: 'methods', label: 'Payment Methods' },
                { key: 'integration', label: 'Integration' },
                { key: 'notifications', label: 'Notifications' },
                { key: 'config', label: 'Config' },
              ]}
            />
          </div>

          {/* TAB 1: GENERAL */}
          {tab === 'general' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Mail Listener Overview */}
              <div className="card">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--raised)', border: '1px solid var(--border)', color: 'var(--bone)', display: 'grid', placeItems: 'center' }}>
                      <Mail size={18} />
                    </div>
                    <div>
                      <div className="card-title">IMAP Email Listener &amp; Auto-Verifier</div>
                      <div className="card-sub">Real-time payment receipt monitoring for Slice Bank</div>
                    </div>
                  </div>
                  <Badge tone="status-ok">TLS 993 Active</Badge>
                </div>

                <div className="form-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                  <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px 14px', borderRadius: 8 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                      Polling Frequency
                    </div>
                    <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: 'var(--bone)' }}>
                      Every {pollInterval || '5'} Seconds
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Non-blocking background loop</div>
                  </div>

                  <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px 14px', borderRadius: 8 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                      Active Monitor Mail
                    </div>
                    <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--bone)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {email || 'Not configured'}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Secure IMAP App Password</div>
                  </div>

                  <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', padding: '12px 14px', borderRadius: 8 }}>
                    <div style={{ fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
                      Auto-Matching Engine
                    </div>
                    <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: 'var(--ok)' }}>
                      Dynamic Decimal Paise
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Range: ₹0.01 – ₹0.49 offsets</div>
                  </div>
                </div>
              </div>

              {/* Editable Platform Preferences */}
              <div className="card">
                <div className="card-head">
                  <div>
                    <div className="card-title">Platform Preferences</div>
                    <div className="card-sub">Global runtime options and checkout expiration policies</div>
                  </div>
                </div>
                <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <div>
                    <div className="form-label">Platform Name</div>
                    <label className="field">
                      <input
                        type="text"
                        value={platformName}
                        onChange={(e) => setPlatformName(e.target.value)}
                        placeholder="e.g. AventasPay"
                        style={{ width: '100%' }}
                      />
                    </label>
                  </div>
                  <div>
                    <div className="form-label">Support Email</div>
                    <label className="field">
                      <input
                        type="email"
                        value={supportEmail}
                        onChange={(e) => setSupportEmail(e.target.value)}
                        placeholder="e.g. support@aventaspay.com"
                        style={{ width: '100%' }}
                      />
                    </label>
                  </div>
                  <div>
                    <div className="form-label">System Timezone</div>
                    <label className="field">
                      <input
                        type="text"
                        value={systemTimezone}
                        onChange={(e) => setSystemTimezone(e.target.value)}
                        placeholder="e.g. Asia/Kolkata (UTC+05:30)"
                        style={{ width: '100%' }}
                      />
                    </label>
                  </div>
                  <div>
                    <div className="form-label">Settlement Currency</div>
                    <label className="field">
                      <input
                        type="text"
                        value={settlementCurrency}
                        onChange={(e) => setSettlementCurrency(e.target.value)}
                        placeholder="e.g. INR (₹)"
                        style={{ width: '100%' }}
                      />
                    </label>
                  </div>
                  <div>
                    <div className="form-label">Payment TTL Expiry (Minutes)</div>
                    <label className="field">
                      <input
                        type="number"
                        min="1"
                        max="120"
                        value={paymentTtlMinutes}
                        onChange={(e) => setPaymentTtlMinutes(e.target.value)}
                        placeholder="10"
                        style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                      />
                    </label>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                      Duration before an unpaid order expires and moves to review (default 10m)
                    </div>
                  </div>
                  <div>
                    <div className="form-label">Database Engine</div>
                    <label className="field">
                      <input
                        type="text"
                        value="SQLite (Native Persistent Engine)"
                        readOnly
                        style={{ width: '100%', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: PAYMENT METHODS */}
          {tab === 'methods' && (
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Payment Gateways &amp; Methods</div>
                  <div className="card-sub">Active payment processor integrations for customer checkouts</div>
                </div>
              </div>

              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  padding: 18,
                  background: 'var(--surface)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 10,
                      background: 'var(--raised)',
                      border: '1px solid var(--border)',
                      color: 'var(--bone)',
                      display: 'grid',
                      placeItems: 'center',
                    }}
                  >
                    <CreditCard size={22} />
                  </div>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--bone)' }}>Slice Bank UPI</span>
                      <Badge tone="status-ok">Active &amp; Primary</Badge>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                      Payee VPA: <span className="mono" style={{ color: 'var(--bone)', fontWeight: 500 }}>{upiId || 'Not configured'}</span>
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                      Auto-verified via real-time IMAP email listener (5s sync interval)
                    </div>
                  </div>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 12, color: 'var(--ok)', fontWeight: 600 }}>● Online</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Zero manual gateway fees</div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: INTEGRATION */}
          {tab === 'integration' && (
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">IMAP &amp; UPI Integration Credentials</div>
                  <div className="card-sub">Configure your Slice Bank monitor account and UPI recipient details</div>
                </div>
              </div>

              <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <div className="form-label">Monitor Email Address</div>
                  <label className="field">
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="e.g. cvvbypasser@gmail.com"
                      style={{ width: '100%' }}
                    />
                  </label>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    Email account receiving Slice Bank payment notifications
                  </div>
                </div>

                <div>
                  <div className="form-label">IMAP App Password (Masked)</div>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={appPassword}
                      onChange={(e) => setAppPassword(e.target.value)}
                      placeholder={showPassword ? 'Enter app password' : maskSecret(appPassword)}
                      style={{
                        width: '100%',
                        padding: '10px 38px 10px 12px',
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        color: 'var(--bone)',
                        fontSize: 13,
                        fontFamily: 'var(--font-mono)',
                        outline: 'none',
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      style={{
                        position: 'absolute',
                        right: 10,
                        background: 'none',
                        border: 'none',
                        color: 'var(--muted)',
                        cursor: 'pointer',
                        padding: 4,
                      }}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    Google Account &gt; Security &gt; 2-Step Verification &gt; App Passwords
                  </div>
                </div>

                <div>
                  <div className="form-label">Sync Interval (Seconds)</div>
                  <label className="field">
                    <input
                      type="number"
                      min="2"
                      max="60"
                      value={pollInterval}
                      onChange={(e) => setPollInterval(e.target.value)}
                      style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                    />
                  </label>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    Interval between IMAP mailbox sweeps (Default: 5s)
                  </div>
                </div>

                <div>
                  <div className="form-label">Primary Slice UPI ID (Payee VPA)</div>
                  <label className="field">
                    <input
                      type="text"
                      value={upiId}
                      onChange={(e) => setUpiId(e.target.value)}
                      placeholder="e.g. cvvbypasser@slc"
                      style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                    />
                  </label>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    Destination UPI ID generated inside customer QR codes and UPI intents
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: NOTIFICATIONS */}
          {tab === 'notifications' && (
            <div className="card">
              <div className="card-head">
                <div>
                  <div className="card-title">Notification Preferences</div>
                  <div className="card-sub">Automatic alerts and system notifications</div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="setting-row">
                  <div className="setting-info">
                    <div className="setting-name">Email Alerts</div>
                    <div className="setting-desc">Receive payment confirmation emails upon auto-matching</div>
                  </div>
                  <button
                    type="button"
                    className="motion-toggle"
                    role="switch"
                    aria-checked={emailAlerts}
                    onClick={() => setEmailAlerts(!emailAlerts)}
                  >
                    <i />
                  </button>
                </div>

                <div className="setting-row">
                  <div className="setting-info">
                    <div className="setting-name">Instant Payment Alerts</div>
                    <div className="setting-desc">Real-time alerts for incoming payments and UTR verifications</div>
                  </div>
                  <button
                    type="button"
                    className="motion-toggle"
                    role="switch"
                    aria-checked={paymentAlerts}
                    onClick={() => setPaymentAlerts(!paymentAlerts)}
                  >
                    <i />
                  </button>
                </div>

                <div className="setting-row">
                  <div className="setting-info">
                    <div className="setting-name">Order Timeout / Manual Review Alerts</div>
                    <div className="setting-desc">Trigger notification when an order reaches TTL window without matching</div>
                  </div>
                  <button
                    type="button"
                    className="motion-toggle"
                    role="switch"
                    aria-checked={timeoutAlerts}
                    onClick={() => setTimeoutAlerts(!timeoutAlerts)}
                  >
                    <i />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 5: CONFIG */}
          {tab === 'config' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Discord & Secondary Slice Account */}
              <div className="card">
                <div className="card-head">
                  <div>
                    <div className="card-title">Webhooks &amp; Secondary Slice Account</div>
                    <div className="card-sub">Discord notifications and backup Slice Bank credentials</div>
                  </div>
                </div>

                <div className="form-grid" style={{ gridTemplateColumns: '1fr', gap: 14, marginBottom: 16 }}>
                  <div>
                    <div className="form-label">Discord Bot Webhook URL</div>
                    <label className="field">
                      <input
                        type="url"
                        value={discordWebhookUrl}
                        onChange={(e) => setDiscordWebhookUrl(e.target.value)}
                        placeholder="https://discord.com/api/webhooks/..."
                        style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                      />
                    </label>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                      Instant payment notifications sent directly to your Discord channel
                    </div>
                  </div>
                </div>

                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--bone)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <CreditCard size={15} color="var(--accent)" />
                  <span>Secondary Account (Slice Bank Only)</span>
                </div>

                <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <div>
                    <div className="form-label">Secondary Monitor Email</div>
                    <label className="field">
                      <input
                        type="email"
                        value={secondaryEmail}
                        onChange={(e) => setSecondaryEmail(e.target.value)}
                        placeholder="e.g. secondary@gmail.com"
                        style={{ width: '100%' }}
                      />
                    </label>
                  </div>

                  <div>
                    <div className="form-label">Secondary IMAP App Password (Masked)</div>
                    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                      <input
                        type={showSecondaryPassword ? 'text' : 'password'}
                        value={secondaryAppPassword}
                        onChange={(e) => setSecondaryAppPassword(e.target.value)}
                        placeholder={showSecondaryPassword ? 'Enter app password' : maskSecret(secondaryAppPassword)}
                        style={{
                          width: '100%',
                          padding: '10px 38px 10px 12px',
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          color: 'var(--bone)',
                          fontSize: 13,
                          fontFamily: 'var(--font-mono)',
                          outline: 'none',
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowSecondaryPassword(!showSecondaryPassword)}
                        style={{
                          position: 'absolute',
                          right: 10,
                          background: 'none',
                          border: 'none',
                          color: 'var(--muted)',
                          cursor: 'pointer',
                          padding: 4,
                        }}
                      >
                        {showSecondaryPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  </div>

                  <div style={{ gridColumn: 'span 2' }}>
                    <div className="form-label">Secondary Slice UPI ID (Payee VPA)</div>
                    <label className="field">
                      <input
                        type="text"
                        value={secondaryUpiId}
                        onChange={(e) => setSecondaryUpiId(e.target.value)}
                        placeholder="e.g. backup@slc"
                        style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
                      />
                    </label>
                  </div>
                </div>
              </div>

              {/* Universal Admin Secret Key */}
              <div className="card">
                <div className="card-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--raised)', border: '1px solid var(--border)', color: 'var(--bone)', display: 'grid', placeItems: 'center' }}>
                      <KeyRound size={16} />
                    </div>
                    <div>
                      <div className="card-title">Universal Admin Secret Key</div>
                      <div className="card-sub">Universal password required to access this admin dashboard</div>
                    </div>
                  </div>
                </div>

                {/* Current Key Display */}
                <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>Current Active Secret Key:</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="mono" style={{ fontSize: 16, color: 'var(--bone)', letterSpacing: '0.16em', fontWeight: 600 }}>
                      ••••••••••••••••
                    </span>
                  </div>
                </div>

                {/* Change Secret Key Form */}
                <form onSubmit={handleUpdateSecretKey}>
                  <div className="form-label">Set New Universal Secret Key</div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <div style={{ position: 'relative', flex: 1, display: 'flex', alignItems: 'center' }}>
                      <input
                        type={showNewKey ? 'text' : 'password'}
                        value={newSecretKey}
                        onChange={(e) => setNewSecretKey(e.target.value)}
                        placeholder="Enter new strong secret key (min 6 characters)"
                        style={{
                          width: '100%',
                          padding: '10px 38px 10px 12px',
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          color: 'var(--bone)',
                          fontSize: 13,
                          fontFamily: 'var(--font-mono)',
                          outline: 'none',
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowNewKey(!showNewKey)}
                        style={{
                          position: 'absolute',
                          right: 10,
                          background: 'none',
                          border: 'none',
                          color: 'var(--muted)',
                          cursor: 'pointer',
                          padding: 4,
                        }}
                      >
                        {showNewKey ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                    <button
                      type="submit"
                      disabled={updatingKey || !newSecretKey.trim()}
                      className="btn primary"
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      <KeyRound size={13} /> {updatingKey ? 'Updating...' : 'Update Key'}
                    </button>
                  </div>
                </form>
              </div>

              {/* Danger Zone */}
              <div className="card" style={{ borderColor: 'rgba(239,68,68,0.3)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <div className="card-title" style={{ color: 'var(--bad)' }}>Danger Zone</div>
                    <div className="card-sub">
                      Clear the entire SQLite database. Deletes all orders, incoming payments, reviews, and chats. Retains only the 1 Rs demo product.
                    </div>
                  </div>
                  {allowDbReset ? (
                    <button
                      className="btn danger"
                      onClick={() => {
                        setDeleteConfirmText('');
                        setDeleteAdminKey('');
                        setClearDbError('');
                        setShowClearModal(true);
                      }}
                      disabled={clearingDb}
                    >
                      <Trash2 size={13} /> {clearingDb ? 'Clearing...' : 'Clear Whole Database'}
                    </button>
                  ) : (
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', padding: '6px 12px', background: 'var(--surface)', borderRadius: 6, border: '1px solid var(--border)' }}>
                      Database reset is disabled
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Modal for Clear DB confirmation */}
          {showClearModal && (
            <div
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(0,0,0,0.8)',
                backdropFilter: 'blur(4px)',
                display: 'grid',
                placeItems: 'center',
                zIndex: 9999,
                padding: 16,
              }}
            >
              <div
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--bad)',
                  borderRadius: 16,
                  padding: 24,
                  maxWidth: 440,
                  width: '100%',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--bad)', marginBottom: 12 }}>
                  <AlertTriangle size={24} />
                  <span style={{ fontSize: 18, fontWeight: 700 }}>Confirm Database Wipe</span>
                </div>
                <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 16 }}>
                  Are you sure you want to clear the entire database? This will permanently delete all order records, payments, chat messages, and reviews. Only the single ₹1 demo product will be kept.
                </p>

                {clearDbError && (
                  <div style={{ background: 'var(--bad-bg)', border: '1px solid var(--bad-border)', color: 'var(--bad)', padding: '8px 12px', borderRadius: 8, fontSize: 12, marginBottom: 14 }}>
                    {clearDbError}
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
                      Type <strong style={{ color: 'var(--bad)' }}>DELETE EVERYTHING</strong> to confirm:
                    </label>
                    <input
                      type="text"
                      value={deleteConfirmText}
                      onChange={(e) => setDeleteConfirmText(e.target.value)}
                      placeholder="Type DELETE EVERYTHING"
                      style={{ width: '100%', height: 38, padding: '0 12px', fontSize: 13, fontFamily: 'var(--font-mono)' }}
                    />
                  </div>

                  <div>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 6 }}>
                      Enter Active Admin Key:
                    </label>
                    <input
                      type="password"
                      value={deleteAdminKey}
                      onChange={(e) => setDeleteAdminKey(e.target.value)}
                      placeholder="Active admin secret key"
                      style={{ width: '100%', height: 38, padding: '0 12px', fontSize: 13, fontFamily: 'var(--font-mono)' }}
                    />
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                  <button
                    className="btn ghost"
                    onClick={() => {
                      setShowClearModal(false);
                      setDeleteConfirmText('');
                      setDeleteAdminKey('');
                      setClearDbError('');
                    }}
                    disabled={clearingDb}
                  >
                    Cancel
                  </button>
                  <button
                    className="btn danger"
                    onClick={handleClearDatabase}
                    disabled={clearingDb || deleteConfirmText !== 'DELETE EVERYTHING' || !deleteAdminKey.trim()}
                    style={{
                      opacity: (deleteConfirmText !== 'DELETE EVERYTHING' || !deleteAdminKey.trim() || clearingDb) ? 0.4 : 1,
                      cursor: (deleteConfirmText !== 'DELETE EVERYTHING' || !deleteAdminKey.trim() || clearingDb) ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {clearingDb ? 'Wiping...' : 'Yes, Wipe Everything'}
                  </button>
                </div>
              </div>
            </div>
          )}
          {/* A24: Sticky Unsaved changes bar */}
          <div id="motionSaveBar" className={isDirty ? 'visible' : ''}>
            <span
              className="motion-pulse-dot pulse"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--warn)',
                display: 'inline-block',
                flexShrink: 0,
              }}
            />
            <b style={{ fontSize: 13, color: 'var(--bone)', whiteSpace: 'nowrap' }}>Unsaved changes</b>
            <button
              type="button"
              className="btn ghost sm"
              onClick={handleDiscard}
              style={{ padding: '6px 12px', fontSize: 12 }}
              disabled={saving}
            >
              Discard
            </button>
            <button
              type="button"
              className="btn primary sm"
              onClick={handleSaveSettings}
              disabled={saving}
              style={{ padding: '6px 14px', fontSize: 12, minWidth: 90 }}
            >
              {saving ? (
                <>
                  <span className="motion-spinner" style={{ width: 12, height: 12, marginRight: 6 }} />
                  <span>Saving...</span>
                </>
              ) : (
                'Save changes'
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}