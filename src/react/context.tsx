import React, { createContext, useContext, ReactNode } from "react";
import type { MetaRouterInterface } from "../types";

export const MetaRouterContext = createContext<MetaRouterInterface | null>(
  null
);

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
