import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "./api";

/** Shared by React and the plain-TS event client. Client errors are final; network errors retry. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, error) => {
        if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
        return count < 2;
      },
    },
  },
});
