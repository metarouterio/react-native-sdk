import React, { createContext, useContext } from "react";
import type { AnalyticsInterface } from "./MetaRouter";

const AnalyticsContext = createContext<AnalyticsInterface | null>(null);

export const MetaRouterProvider: React.FC<{
  client: AnalyticsInterface;
  children: React.ReactNode;
}> = ({ client, children }) => (
  <AnalyticsContext.Provider value={client}>
    {children}
  </AnalyticsContext.Provider>
);

export const useMetaRouter = (): AnalyticsInterface => {
  const ctx = useContext(AnalyticsContext);
  if (!ctx)
    throw new Error("useMetaRouter must be used inside a <MetaRouterProvider>");
  return ctx;
};
