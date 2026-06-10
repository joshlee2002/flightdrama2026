export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

// Password-based auth — always redirect to /login
export const getLoginUrl = (_returnPath?: string): string => "/login";
