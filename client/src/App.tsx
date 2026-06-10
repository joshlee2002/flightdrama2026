import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Dashboard from "./pages/Dashboard";
import Sources from "./pages/Sources";
import Historical from "./pages/Historical";
import IngestUrls from "@/pages/IngestUrls";
import ApprovedQueue from "@/pages/ApprovedQueue";
import Insights from "@/pages/Insights";
import Login from "@/pages/Login";
import ExampleArticles from "@/pages/ExampleArticles";
import Digest from "@/pages/Digest";
import AssistantPanel from "@/components/AssistantPanel";
import { useAuth } from "./_core/hooks/useAuth";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/sources" component={Sources} />
      <Route path="/historical" component={Historical} />
      <Route path="/ingest" component={IngestUrls} />
      <Route path="/approved" component={ApprovedQueue} />
      <Route path="/insights" component={Insights} />
      <Route path="/login" component={Login} />
      <Route path="/example-articles" component={ExampleArticles} />
      <Route path="/digest" component={Digest} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppContent() {
  const { isAuthenticated } = useAuth();
  return (
    <>
      <Router />
      {/* FlightDrama AI Assistant — only shown when logged in */}
      {isAuthenticated && <AssistantPanel />}
    </>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster theme="dark" position="bottom-right" />
          <AppContent />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
