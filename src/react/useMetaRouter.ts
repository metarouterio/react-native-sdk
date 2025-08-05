import { useContext } from "react";
import { AnalyticsInterface } from "../analytics/types";
import { MetaRouterContext } from "./context";

/**
 * Hook to access the analytics client from MetaRouter context.
 */
export const useMetaRouter = (): { analytics: AnalyticsInterface } => {
  const context = useContext(MetaRouterContext);

  if (!context?.analytics) {
    throw new Error(
      "useMetaRouter must be used within a <MetaRouterProvider> with an analytics client."
    );
  }

  return { analytics: context.analytics };
};
