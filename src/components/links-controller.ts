import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { formatCompactNumber } from "#/lib/present";
import { hydrateProfileHandles } from "#/lib/profile-hydration-client";
import { queryKeys } from "#/lib/query-client";
import { useDeploymentMode } from "#/lib/deployment-mode";
import type { LinksRouteSearch, RouteSearchChange } from "#/lib/route-search";
import type {
	LinkInsightKind,
	LinkInsightRange,
	LinkInsightSort,
	LinkInsightSource,
} from "#/lib/types";
import {
	LINK_INSIGHTS_CACHE_MAX_AGE_MS,
	PROFILE_HYDRATION_DELAY_MS,
	PROFILE_HYDRATION_LIMIT,
	collectProfilesForHydration,
	fetchLinkInsights,
	linkInsightQueryKey,
} from "./links-model";

export function useLinksController(
	filters: LinksRouteSearch,
	onFiltersChange: RouteSearchChange<LinksRouteSearch>,
) {
	const queryClient = useQueryClient();
	const { readOnly } = useDeploymentMode();
	const { kind, range, source, sort, q: search } = filters;
	const insightsQuery = useQuery({
		queryKey: linkInsightQueryKey(kind, range, sort, source),
		queryFn: ({ signal }) =>
			fetchLinkInsights(kind, range, sort, source, signal),
		staleTime: LINK_INSIGHTS_CACHE_MAX_AGE_MS,
	});
	const data = insightsQuery.data ?? null;

	useEffect(() => {
		if (!data) return;
		const prefetchKind = kind === "links" ? "videos" : "links";
		const timer = window.setTimeout(() => {
			void queryClient.prefetchQuery({
				queryKey: linkInsightQueryKey(prefetchKind, range, sort, source),
				queryFn: ({ signal }) =>
					fetchLinkInsights(prefetchKind, range, sort, source, signal),
				staleTime: LINK_INSIGHTS_CACHE_MAX_AGE_MS,
			});
		}, 250);
		return () => window.clearTimeout(timer);
	}, [data, kind, queryClient, range, sort, source]);

	useEffect(() => {
		const handles = collectProfilesForHydration(data);
		if (readOnly || handles.length === 0) return;

		let active = true;
		let idleId: number | null = null;
		const runHydration = () => {
			hydrateProfileHandles(queryClient, handles, {
				limit: PROFILE_HYDRATION_LIMIT,
			})
				.then((response) => {
					if (!active) return;
					if (
						response.fetchedResults.some((result) => result.status === "hit")
					) {
						void queryClient.invalidateQueries({
							queryKey: queryKeys.linkInsights,
						});
					}
				})
				.catch((error: unknown) => {
					if (!active) return;
					console.warn("Profile hydration failed", error);
				});
		};
		const timer = window.setTimeout(() => {
			if ("requestIdleCallback" in window) {
				idleId = window.requestIdleCallback(runHydration, { timeout: 2500 });
			} else {
				runHydration();
			}
		}, PROFILE_HYDRATION_DELAY_MS);

		return () => {
			active = false;
			window.clearTimeout(timer);
			if (idleId !== null && "cancelIdleCallback" in window) {
				window.cancelIdleCallback(idleId);
			}
		};
	}, [data, queryClient, readOnly]);

	const items = useMemo(() => {
		const query = search.trim().toLowerCase();
		return (data?.items ?? []).filter((item) => {
			if (!query) return true;
			return [
				item.title,
				item.description,
				item.displayUrl,
				item.host,
				item.topSharer?.handle,
				...item.mentions.map((mention) => mention.commentText),
			]
				.filter(Boolean)
				.some((value) => String(value).toLowerCase().includes(query));
		});
	}, [data?.items, search]);

	const subtitle = useMemo(() => {
		if (!data) return "Loading link memory...";
		const label = kind === "videos" ? "video URLs" : "URLs";
		return `${formatCompactNumber(data.stats.occurrences)} ${label} across ${formatCompactNumber(data.stats.groups)} groups`;
	}, [data, kind]);

	return {
		kind,
		setKind: (value: LinkInsightKind) =>
			onFiltersChange({ ...filters, kind: value }),
		range,
		setRange: (value: LinkInsightRange) =>
			onFiltersChange({ ...filters, range: value }),
		source,
		setSource: (value: LinkInsightSource) =>
			onFiltersChange({ ...filters, source: value }),
		sort,
		setSort: (value: LinkInsightSort) =>
			onFiltersChange({ ...filters, sort: value }),
		search,
		setSearch: (value: string) =>
			onFiltersChange({ ...filters, q: value }, { replace: true }),
		items,
		subtitle,
		loading: insightsQuery.isPending,
		error: insightsQuery.error
			? insightsQuery.error instanceof Error
				? insightsQuery.error.message
				: "Link insights unavailable"
			: null,
		retry: insightsQuery.refetch,
	};
}
