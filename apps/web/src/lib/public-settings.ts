import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

const FIVE_MINUTES = 5 * 60_000;

/** The admin values the help texts quote (`GET /api/settings/public`); undefined until loaded. */
export function usePublicSettings() {
  return useQuery({
    queryKey: ["settings", "public"],
    queryFn: ({ signal }) => api.publicSettings(signal),
    staleTime: FIVE_MINUTES,
    retry: false,
  }).data;
}
