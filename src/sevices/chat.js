import {serverRequest,remoteSession} from "./remote";
export const listChatUsers=()=>serverRequest("/chat/users");
export const getChatHistory=userId=>serverRequest(`/chat/history/${encodeURIComponent(userId)}`);
export function chatSocket(){const session=remoteSession();if(!session)throw Error("authentication_required");const url=new URL("/api/v1/chat",session.address);url.protocol=url.protocol==="https:"?"wss:":"ws:";url.searchParams.set("token",session.token);return new WebSocket(url)}
