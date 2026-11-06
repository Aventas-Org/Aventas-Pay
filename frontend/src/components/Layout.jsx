import React, { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Package, ArrowLeftRight, ShoppingCart, Mail, BarChart3,
  ShieldAlert, Settings, LogOut, PanelLeftClose, PanelLeftOpen, Menu, X
} from 'lucide-react';
import { AvMark, AvWordmark } from './AvLogo.jsx';
import { systemStatus as fallbackStatus } from '../data.js';
import { updateNavIndicator, initSpotlight, initVisibilityListener } from '../motion.js';

const links = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/products', label: 'Products & Embed', icon: Package },
  { to: '/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { to: '/orders', label: 'Orders', icon: ShoppingCart },
  { to: '/emails', label: 'Emails', icon: Mail },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
  { to: '/manual-review', label: 'Manual Review', icon: ShieldAlert },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [statuses, setStatuses] = useState(fallbackStatus);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const navRef = useRef(null);
  const indicatorRef = useRef(null);

  // Initialize Card Spotlight and Visibility Listener (Rule A3)
  useEffect(() => {
    const cleanupSpotlight = initSpotlight();
    const cleanupVisibility = initVisibilityListener();
    return () => {
      cleanupSpotlight();
      cleanupVisibility();
    };
  }, []);

  // Update Sliding Nav Indicator (Rule A5)
  useEffect(() => {
    const update = () => {
      if (!navRef.current || !indicatorRef.current) return;
      const activeLink = navRef.current.querySelector('a.active');
      if (activeLink) {
        updateNavIndicator(navRef.current, activeLink, indicatorRef.current);
      }
    };
    // Run after DOM render
    const raf = requestAnimationFrame(update);
    const timer = setTimeout(update, 100);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      window.removeEventListener('resize', update);
    };
  }, [location.pathname, collapsed]);

  useEffect(() => {
    const adminKey = localStorage.getItem('aventas_admin_key') || '';
    fetch('/api/admin/overview', {
      headers: { 'x-admin-key': adminKey },
    })
      .then((r) => {
        if (r.status === 401) {
          localStorage.removeItem('aventas_admin_key');
          navigate('/login');
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((data) => {
        if (data?.systemStatus) {
          setStatuses(data.systemStatus);
        }
      })
      .catch(() => {});
  }, [navigate]);

  const handleLogout = () => {
    localStorage.removeItem('aventas_admin_key');
    navigate('/login');
  };

  return (
    <div className="app">
      {/* Mobile Backdrop */}
      {mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            backdropFilter: 'blur(3px)',
            zIndex: 45,
          }}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`sidebar ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}
      >
        {/* Brand Header */}
        <div className="sidebar-header">
          {!collapsed ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <AvMark size={24} />
              <AvWordmark subtitle="GATEWAY" />
            </div>
          ) : (
            <div style={{ margin: '0 auto' }}>
              <AvMark size={24} />
            </div>
          )}

          <button
            onClick={() => setCollapsed(!collapsed)}
            className="btn ghost sm"
            title={collapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
            style={{
              padding: 4,
              width: 26,
              height: 26,
              color: 'var(--muted)',
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {collapsed ? <PanelLeftOpen size={15} strokeWidth={1.5} /> : <PanelLeftClose size={15} strokeWidth={1.5} />}
          </button>
        </div>

        {/* Navigation Links with A5 Sliding Active Indicator */}
        <nav className="nav nav-sliding-container" ref={navRef}>
          <div id="navSlidingIndicator" ref={indicatorRef} />
          {links.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => (isActive ? 'active' : '')}
              title={collapsed ? label : undefined}
              onClick={() => setMobileOpen(false)}
              style={{ position: 'relative', zIndex: 1 }}
            >
              <Icon size={16} strokeWidth={1.5} style={{ flexShrink: 0 }} />
              {!collapsed && <span className="sidebar-label">{label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* Compact System Status Box */}
        {!collapsed && (
          <div className="sys-box">
            <div className="sys-title">System Status</div>
            {statuses.slice(0, 4).map((s) => (
              <div key={s.name} className="sys-row" title={s.val || 'Active'}>
                <span>
                  <span className="dot" />
                  {s.name}
                </span>
                <span className="mono" style={{ fontSize: 9.5, color: '#71717A' }}>
                  {s.val?.includes('(') ? s.val.split('(')[1].replace(')', '') : 'OK'}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* User Profile Footer */}
        <div className="user-box" style={{ justifyContent: collapsed ? 'center' : 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div className="avatar">A</div>
            {!collapsed && (
              <div>
                <div className="user-name">Admin</div>
                <div className="user-role mono" style={{ fontSize: 9.5, color: 'var(--muted)' }}>
                  SECURE KEY
                </div>
              </div>
            )}
          </div>
          {!collapsed && (
            <button
              onClick={handleLogout}
              title="Sign Out"
              style={{
                color: 'var(--muted)',
                padding: 6,
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                transition: 'color 0.15s',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--bad)')}
              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--muted)')}
            >
              <LogOut size={15} strokeWidth={1.5} />
            </button>
          )}
        </div>
      </aside>

      {/* Main Outlet */}
      <div className="main">
        {/* Mobile Nav Bar Toggle */}
        <div
          className="mobile-bar"
          style={{
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--surface)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AvMark size={20} />
            <span style={{ fontFamily: 'var(--font-brand)', fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--bone)' }}>
              AVENTAS
            </span>
          </div>
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            style={{ color: 'var(--bone)', padding: 4 }}
          >
            {mobileOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
        </div>

        {/* A7 Page Enter Stagger */}
        <div key={location.pathname} className="motion-page-enter">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
