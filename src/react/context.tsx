import React, { createContext, useContext, ReactNode } from "react";
import type { MetaRouterInterface } from "../types";

/**
 * Context for the MetaRouter analytics client.
 * @param instance - The analytics client instance.
 */
export const MetaRouterContext = createContext<MetaRouterInterface | null>(
  null
);

/**
 * Provider for the MetaRouter analytics client.
 * @param children - The children to render.
 * @param instance - The analytics client instance.
 */
export const MetaRouterProvider = ({
  children,
  instance,
}: {
  children: ReactNode;
  instance: MetaRouterInterface;
}) => {
  return (
    <MetaRouterContext.Provider value={instance}>
      {children}
    </MetaRouterContext.Provider>
  );
};
