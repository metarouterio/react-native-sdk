import { useContext } from "react";
import { MetaRouter } from "../MetaRouter";
import { MetaRouterContext } from "./context";

export const useMetaRouter = (): typeof MetaRouter => {
    const ctx = useContext(MetaRouterContext);
    if (!ctx)
      throw new Error("useMetaRouter must be used within MetaRouterProvider");
    return ctx;
  };
  
  