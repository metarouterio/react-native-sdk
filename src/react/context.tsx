import React, { createContext, ReactNode } from "react";
import { AnalyticsInterface } from "../analytics/types";

export interface MetaRouterContextValue {
  analytics: AnalyticsInterface;
}

export const MetaRouterContext = createContext<MetaRouterContextValue | null>(
  null
);

interface MetaRouterProviderProps {
  children: ReactNode;
  analyticsClient: AnalyticsInterface;
}

export const MetaRouterProvider = ({
  children,
  analyticsClient,
}: MetaRouterProviderProps) => {
  const value: MetaRouterContextValue = {
    analytics: analyticsClient,
  };

  return (
    <MetaRouterContext.Provider value={value}>
      {children}
    </MetaRouterContext.Provider>
  );
};
