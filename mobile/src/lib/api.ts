import { createApi } from "shared";
import { backendUrl } from "./config";

export const api = createApi(backendUrl);
