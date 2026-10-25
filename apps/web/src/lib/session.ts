import type { SessionResponse } from "@gachipad/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { noteSessionIdentity } from "./device";
import { queryClient } from "./query";

export const SESSION_KEY = ["session"] as const;

/**
 * The anonymous session: who I am for the whole tab. Fetched once; the cookie keeps it stable.
 * Nothing joins a share before it is there, so another account's copies are gone by then.
 */
export const sessionQuery = {
  queryKey: SESSION_KEY,
  queryFn: async ({ signal }: { signal?: AbortSignal }) => {
    const session = await api.session(signal);
    await noteSessionIdentity(session);
    return session;
  },
  staleTime: Number.POSITIVE_INFINITY,
};

export function useSession() {
  return useQuery(sessionQuery);
}

export function getCachedSession(): SessionResponse | undefined {
  return queryClient.getQueryData<SessionResponse>(SESSION_KEY);
}

/** Name and color: the cache updates at once, the server follows. */
export function useUpdateProfile() {
  return useMutation({
    mutationFn: api.patchSession,
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: SESSION_KEY });
      const previous = queryClient.getQueryData<SessionResponse>(SESSION_KEY);
      if (previous) {
        queryClient.setQueryData<SessionResponse>(SESSION_KEY, {
          ...previous,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.color === undefined ? {} : { color: patch.color }),
        });
      }
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) queryClient.setQueryData(SESSION_KEY, context.previous);
    },
    onSuccess: (session) => queryClient.setQueryData(SESSION_KEY, session),
  });
}

/** A stable 3-digit number for the "Guest 123" fallback name of a client. */
export function guestNumber(clientId: string): number {
  let hash = 0;
  for (let i = 0; i < clientId.length; i++) hash = (hash * 31 + clientId.charCodeAt(i)) >>> 0;
  return 100 + (hash % 900);
}
