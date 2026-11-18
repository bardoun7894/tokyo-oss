import { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { postApi } from "../../api/client";
import { useModuleVisible } from "../../hooks/useSettings";

interface NavItem {
  path: string;
  icon: string;
  label: string;
  openGroupChat?: boolean; // opens example.com/chatAnym in a new tab, already logged in
}

const NAV_MAIN: NavItem[] = [
  { path: "/", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4", label: "Home" },
  { path: "/tasks", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4", label: "Tasks" },
  { path: "/work", icon: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z", label: "Work" },
  { path: "/habits", icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z", label: "Habits" },
  { path: "/deen", icon: "M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z", label: "Deen" },
];

const NAV_DATA: NavItem[] = [
  { path: "/finance", icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z", label: "Finance" },
  { path: "/money", icon: "M3 10h18M7 15h4m-7 4h16a2 2 0 002-2V7a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2z", label: "Loans" },
  { path: "/shop", icon: "M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z", label: "Shop" },
  { path: "/products", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4", label: "Products" },
  { path: "/projects", icon: "M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10", label: "Projects" },
  { path: "/goals", icon: "M13 10V3L4 14h7v7l9-11h-7z", label: "Goals" },
  { path: "/journal", icon: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z", label: "Journal" },
];

const NAV_SYSTEM: NavItem[] = [
  { path: "/schedule", icon: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z", label: "Calendar" },
  { path: "/whatsapp", icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z", label: "WhatsApp" },
  { path: "/group-chat", icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z", label: "Group chat", openGroupChat: true },
  { path: "/instagram", icon: "M16 3H8a5 5 0 00-5 5v8a5 5 0 005 5h8a5 5 0 005-5V8a5 5 0 00-5-5zM12 16a4 4 0 110-8 4 4 0 010 8zM17.5 6.5h.01", label: "Instagram" },
  { path: "/chat", icon: "M7 8h10M7 12h6m-9 8l3-3h11a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v11", label: "Chat" },
  { path: "/media", icon: "M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z", label: "Media" },
  { path: "/transcripts", icon: "M12 1a3 3 0 00-3 3v7a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v1a7 7 0 01-14 0v-1M12 18v4M8 22h8", label: "Transcripts" },
  { path: "/content", icon: "M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z", label: "Content" },
  { path: "/trends", icon: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6", label: "Trends" },
  { path: "/chat-analytics", icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z", label: "Analytics" },
  { path: "/server", icon: "M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01", label: "Server" },
];

const SETTINGS_ICON = "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z";

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

export default function Sidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const visible = useModuleVisible();
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("sidebar_collapsed") === "true"; } catch { return false; }
  });

  useEffect(() => {
    localStorage.setItem("sidebar_collapsed", String(collapsed));
  }, [collapsed]);

  async function openGroupChat() {
    // Open the tab synchronously so the popup blocker allows it, then point it at the one-time link.
    const tab = window.open("", "_blank");
    try {
      const { url } = await postApi<{ url: string }>("/api/groupchat/open");
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (err) {
      tab?.close();
      alert(err instanceof Error ? err.message : "Could not open the group chat");
    }
  }

  function handleClick(item: NavItem) {
    if (item.openGroupChat) { void openGroupChat(); return; }
    navigate(item.path);
  }

  function isActive(item: NavItem) {
    if (item.path === "/") return location.pathname === "/";
    return location.pathname === item.path || location.pathname.startsWith(item.path + "/");
  }

  function renderGroup(items: NavItem[]) {
    return items.filter((item) => visible(item.path)).map((item) => (
      // Group chat opens an external one-time link, so it is a button: as an
      // <a href="/group-chat"> a middle-click landed on the 404 page.
      item.openGroupChat ? (
        <button
          key={item.path}
          type="button"
          className="sb-link"
          onClick={() => handleClick(item)}
          title={collapsed ? item.label : undefined}
        >
          <Icon d={item.icon} />
          {!collapsed && <span className="sb-text">{item.label}</span>}
        </button>
      ) : (
      <a
        key={item.path}
        href={item.path}
        className={`sb-link${isActive(item) ? " active" : ""}`}
        onClick={(e) => { e.preventDefault(); handleClick(item); }}
        title={collapsed ? item.label : undefined}
      >
        <Icon d={item.icon} />
        {!collapsed && <span className="sb-text">{item.label}</span>}
      </a>
      )
    ));
  }

  return (
    <nav className={`sidebar${collapsed ? " sidebar-collapsed" : ""}`}>
      <div className="sb-brand" onClick={() => navigate("/")}>
        <span className="sb-logo">T</span>
        {!collapsed && <span className="sb-brand-text">Tokyo</span>}
      </div>

      <div className="sb-divider" />
      {renderGroup(NAV_MAIN)}
      <div className="sb-divider" />
      {renderGroup(NAV_DATA)}
      <div className="sb-divider" />
      {renderGroup(NAV_SYSTEM)}

      <div style={{ marginTop: "auto", paddingTop: 8 }}>
        {renderGroup([{ path: "/settings", icon: SETTINGS_ICON, label: "Settings" }])}
        <a
          href="#"
          className="sb-link sb-toggle"
          onClick={(e) => { e.preventDefault(); setCollapsed(!collapsed); }}
          title={collapsed ? "Expand" : "Collapse"}
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            {collapsed
              ? <path d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              : <path d="M11 19l-7-7 7-7M19 19l-7-7 7-7" />}
          </svg>
          {!collapsed && <span className="sb-text">Collapse</span>}
        </a>
      </div>
    </nav>
  );
}
