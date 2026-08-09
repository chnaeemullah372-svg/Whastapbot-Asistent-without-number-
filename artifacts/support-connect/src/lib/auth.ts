export const setAuthToken = (token: string) => {
  localStorage.setItem('admin_token', token);
};

export const getAuthToken = () => {
  return localStorage.getItem('admin_token');
};

export const removeAuthToken = () => {
  localStorage.removeItem('admin_token');
};

// Use sessionStorage so the widget resets on every page refresh / new tab
export const setChatSessionId = (id: string) => {
  sessionStorage.setItem('chat_session_id', id);
};

export const getChatSessionId = () => {
  return sessionStorage.getItem('chat_session_id');
};

export const removeChatSessionId = () => {
  sessionStorage.removeItem('chat_session_id');
};
