import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import PanelLogin from "@/pages/panel/login";
import Chats from "@/pages/panel/chats";
import Connect from "@/pages/panel/connect";
import SettingsPage from "@/pages/panel/settings";
import Certificate from "@/pages/panel/certificate";
import Tools from "@/pages/panel/tools";
import Backup from "@/pages/panel/backup";
import Logs from "@/pages/panel/logs";
import Help from "@/pages/panel/help";
import Calls from "@/pages/panel/calls";
import Status from "@/pages/panel/status";

import AdminLogin from "@/pages/adminpanel/login";
import AdminDashboard from "@/pages/adminpanel/dashboard";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      {/* Admin web dashboard */}
      <Route path="/admin/login" component={AdminLogin} />
      <Route path="/admin" component={AdminDashboard} />

      {/* User mobile panel */}
      <Route path="/login" component={PanelLogin} />
      <Route path="/connect" component={Connect} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/certificate" component={Certificate} />
      <Route path="/tools" component={Tools} />
      <Route path="/backup" component={Backup} />
      <Route path="/logs" component={Logs} />
      <Route path="/help" component={Help} />
      <Route path="/calls" component={Calls} />
      <Route path="/status" component={Status} />
      <Route path="/" component={Chats} />

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
