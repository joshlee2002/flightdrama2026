import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from '@shared/const';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { getLoginUrl } from "./const";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Keep data fresh for 30 seconds — prevents unnecessary refetches that can
      // cause the UI to flash empty while a background refetch is in-flight.
      staleTime: 30_000,
      // Keep unused query data in cache for 5 minutes before garbage collecting.
      gcTime: 5 * 60_000,
      // Retry failed queries up to 2 times with exponential backoff.
      retry: 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
      // Do not refetch on window focus — the ProcessingState component polls
      // every 5 s while a story is being processed, so focus-refetch is redundant
      // and causes the approved list to flash empty when switching tabs.
      refetchOnWindowFocus: false,
    },
  },
});

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;

  window.location.href = getLoginUrl();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        const extraHeaders: Record<string, string> = {};
        try {
          const token = localStorage.getItem("app_session_id");
          if (token) extraHeaders["Authorization"] = `Bearer ${token}`;
        } catch {}
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
          headers: { ...(init?.headers as Record<string, string> ?? {}), ...extraHeaders },
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
