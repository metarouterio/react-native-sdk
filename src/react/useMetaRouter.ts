import { useContext } from "react";
import { MetaRouter } from "../MetaRouter";
import { MetaRouterContext } from "./context";
import type { AnalyticsInterface } from "../analytics/types";

export const useMetaRouter = (): { analytics: AnalyticsInterface } => {
    const ctx = useContext(MetaRouterContext);
    if (!ctx)
      throw new Error("useMetaRouter must be used within MetaRouterProvider");
    
    return {
      analytics: ctx.analytics.getClient(),
    };
  };
  
  