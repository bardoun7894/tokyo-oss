import { useEffect, useCallback } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Outlet, Link, useLocation } from "react-router-dom";
import { ToastProvider, useToast } from "./components/ui/Toast";
import { useOverview } from "./hooks/useOverview";
import { timeToMin, nowMin } from "./lib/utils";
import { postApi } from "./api/client";

// Layout
import Sidebar from "./components/layout/Sidebar";
import Header from "./components/layout/Header";
import RightNowStrip from "./components/layout/RightNowStrip";

// Pages
import TasksPage from "./pages/TasksPage";
import WorkPage from "./pages/WorkPage";
import HabitsPage from "./pages/HabitsPage";
import DeenPage from "./pages/DeenPage";
import FinancePage from "./pages/FinancePage";
import ShopPage from "./pages/ShopPage";
import ProductsPage from "./pages/ProductsPage";
import ProjectsPage from "./pages/ProjectsPage";
import GoalsPage from "./pages/GoalsPage";
import JournalPage from "./pages/JournalPage";
import SchedulePage from "./pages/SchedulePage";
import WhatsAppPage from "./pages/WhatsAppPage";
import MediaPage from "./pages/MediaPage";
import TranscriptsPage from "./pages/TranscriptsPage";
import ContentPage from "./pages/ContentPage";
import TrendsPage from "./pages/TrendsPage";
import ServerPage from "./pages/ServerPage";
import ChatAnalyticsPage from "./pages/ChatAnalytics";
import HomePage from "./pages/HomePage";
import InstagramPage from "./pages/InstagramPage";
import ChatPage from "./pages/ChatPage";
import SettingsPage from "./pages/SettingsPage";
import MoneyPage from "./pages/MoneyPage";
import LoginPage from "./pages/LoginPage";

import "./styles/tailwind.css";

import type { OverviewResponse } from "./types";

// Query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// ================================
// Prayer-aware body class logic
// ================================
function usePrayerAwareClass(overview: OverviewResponse | null | undefined) {
  useEffect(() => {
    if (!overview?.prayer) return;

    const p = overview.prayer;
    const now = nowMin();
    const body = document.body;

    body.classList.remove(
      "prayer-fajr",
      "prayer-dhuhr",
      "prayer-maghrib",
      "prayer-isha"
    );

    const fajr = timeToMin(p.fajr);
    const dhuhr = timeToMin(p.dhuhr);
    const maghrib = timeToMin(p.maghrib);
    const isha = timeToMin(p.isha);

    if (now >= fajr && now < dhuhr) {
      body.classList.add("prayer-fajr");
    } else if (now >= dhuhr && now < maghrib) {
      body.classList.add("prayer-dhuhr");
    } else if (now >= maghrib && now < isha) {
      body.classList.add("prayer-maghrib");
    } else if (now >= isha || now < fajr) {
      body.classList.add("prayer-isha");
    }
  }, [overview]);
}

// ================================
// Keyboard shortcuts hook
// ================================
function useKeyboardShortcuts(overview: OverviewResponse | null | undefined) {
  const { showToast } = useToast();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      switch (e.key) {
        case "w": {
          if (overview?.work.activeSession) {
            postApi("/api/work/stop")
              .then(() => {
                showToast("Work stopped!");
                queryClient.invalidateQueries({ queryKey: ["overview"] });
              })
              .catch((err: Error) => showToast(err.message, "error"));
          } else {
            postApi("/api/work/start", { workType: "dev" })
              .then(() => {
                showToast("Work started!");
                queryClient.invalidateQueries({ queryKey: ["overview"] });
              })
              .catch((err: Error) => showToast(err.message, "error"));
          }
          break;
        }
        case "b": {
          postApi("/api/work/break")
            .then((r: unknown) => {
              const res = r as { onBreak?: boolean };
              showToast(res.onBreak ? "Break started!" : "Break ended!");
              queryClient.invalidateQueries({ queryKey: ["overview"] });
            })
            .catch((err: Error) => showToast(err.message, "error"));
          break;
        }
        case "r": {
          queryClient.invalidateQueries({ queryKey: ["overview"] });
          queryClient.invalidateQueries({ queryKey: ["projects"] });
          queryClient.invalidateQueries({ queryKey: ["weekly-trends"] });
          queryClient.invalidateQueries({ queryKey: ["goals"] });
          showToast("Refreshing...", "info");
          break;
        }
      }
    },
    [overview, showToast]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}


// ================================
// Shared Layout — sidebar + header on every page
// ================================
function AppLayout() {
  const { data: overview } = useOverview();
  const overviewData = overview ?? null;

  usePrayerAwareClass(overview);
  useKeyboardShortcuts(overview);

  // A new page starts at the top, not at the previous page's scroll position.
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);

  return (
    <>
      <Sidebar />
      <div className="main-content">
        <Header overview={overviewData} />
        <RightNowStrip overview={overviewData} />
        <Outlet />
      </div>
    </>
  );
}

function NotFoundPage() {
  return (
    <div className="py-10 text-center">
      <h2 className="mb-2 text-xl font-semibold text-fg">Page not found</h2>
      <Link to="/" className="text-accent">Back to Home</Link>
    </div>
  );
}

// ================================
// App (wraps with providers + routing)
// ================================
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<AppLayout />}>
              <Route path="/" element={<HomePage />} />
              <Route path="/tasks" element={<TasksPage />} />
              <Route path="/work" element={<WorkPage />} />
              <Route path="/habits" element={<HabitsPage />} />
              <Route path="/deen" element={<DeenPage />} />
              <Route path="/finance" element={<FinancePage />} />
              <Route path="/shop" element={<ShopPage />} />
              <Route path="/products" element={<ProductsPage />} />
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/goals" element={<GoalsPage />} />
              <Route path="/journal" element={<JournalPage />} />
              <Route path="/schedule" element={<SchedulePage />} />
              <Route path="/whatsapp" element={<WhatsAppPage />} />
              <Route path="/media" element={<MediaPage />} />
              <Route path="/transcripts" element={<TranscriptsPage />} />
              <Route path="/content" element={<ContentPage />} />
              <Route path="/trends" element={<TrendsPage />} />
              <Route path="/server" element={<ServerPage />} />
              <Route path="/chat-analytics" element={<ChatAnalyticsPage />} />
              <Route path="/instagram" element={<InstagramPage />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/money" element={<MoneyPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
