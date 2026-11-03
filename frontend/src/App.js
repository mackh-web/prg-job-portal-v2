import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import "@/App.css";
import { AuthProvider } from "@/context/AuthContext";
import { ThemeProvider } from "@/context/ThemeContext";
import ProtectedRoute from "@/components/ProtectedRoute";
import AppShell from "@/components/AppShell";
import Login from "@/pages/Login";
import AcceptInvitation from "@/pages/AcceptInvitation";
import ForgotPassword from "@/pages/ForgotPassword";
import ResetPassword from "@/pages/ResetPassword";
import Dashboard from "@/pages/Dashboard";
import Jobs from "@/pages/Jobs";
import JobDetails from "@/pages/JobDetails";
import EquipmentSearch from "@/pages/EquipmentSearch";
import EquipmentDetails from "@/pages/EquipmentDetails";
import BuildingInfo from "@/pages/BuildingInfo";
import PrepBayCalendar from "@/pages/PrepBayCalendar";
import Notifications from "@/pages/Notifications";
import UserManagement from "@/pages/UserManagement";
import Faults from "@/pages/Faults";
import FaultDetails from "@/pages/FaultDetails";
import AuditLog from "@/pages/AuditLog";
import Profile from "@/pages/Profile";

function Shell({ children }) {
  return (
    <ProtectedRoute>
      <AppShell>{children}</AppShell>
    </ProtectedRoute>
  );
}

function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <Toaster
          position="top-right"
          theme="dark"
          toastOptions={{ className: "font-body" }}
        />
        <div className="App">
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/accept-invitation" element={<AcceptInvitation />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/" element={<Shell><Dashboard /></Shell>} />
              <Route path="/jobs" element={<Shell><Jobs /></Shell>} />
              <Route path="/jobs/:id" element={<Shell><JobDetails /></Shell>} />
              <Route path="/equipment" element={<Shell><EquipmentSearch /></Shell>} />
              <Route path="/equipment/type/:fixtureType" element={<Shell><EquipmentDetails /></Shell>} />
              <Route path="/building" element={<Shell><BuildingInfo /></Shell>} />
              <Route path="/calendar" element={<Shell><PrepBayCalendar /></Shell>} />
              <Route path="/notifications" element={<Shell><Notifications /></Shell>} />
              <Route path="/users" element={<Shell><UserManagement /></Shell>} />
              <Route path="/faults" element={<Shell><Faults /></Shell>} />
              <Route path="/faults/:id" element={<Shell><FaultDetails /></Shell>} />
              <Route path="/audit" element={<Shell><AuditLog /></Shell>} />
              <Route path="/profile" element={<Shell><Profile /></Shell>} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </div>
      </ThemeProvider>
    </AuthProvider>
  );
}

export default App;