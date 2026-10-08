import axios, { AxiosError } from 'axios'

const BASE_URL = import.meta.env.VITE_API_URL || '/api/v1'

export const api = axios.create({
  baseURL: BASE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
})

// Attach token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('access_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// Auto-refresh on 401
api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as any
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true
      const refresh = localStorage.getItem('refresh_token')
      if (refresh) {
        try {
          const { data } = await axios.post(`${BASE_URL}/auth/refresh`, {
            refresh_token: refresh,
          })
          localStorage.setItem('access_token', data.access_token)
          localStorage.setItem('refresh_token', data.refresh_token)
          original.headers.Authorization = `Bearer ${data.access_token}`
          return api(original)
        } catch {
          localStorage.clear()
          window.location.href = '/login'
        }
      }
    }
    return Promise.reject(error)
  },
)

// ------------------------------------------------------------------ Auth
export const authApi = {
  register: (data: {
    email: string; username: string; password: string
    full_name?: string; organization_name?: string
  }) => api.post('/auth/register', data),

  login: (email: string, password: string) =>
    api.post('/auth/login', { email, password }),

  logout: () => api.post('/auth/logout'),

  me: () => api.get('/auth/me'),

  changePassword: (current_password: string, new_password: string) =>
    api.post('/auth/change-password', { current_password, new_password }),
}

// ------------------------------------------------------------------ Chat
export const chatApi = {
  send: (data: { message: string; session_id?: string; use_rag?: boolean }) =>
    api.post('/chat/', data),

  getSessions: (limit = 20, offset = 0) =>
    api.get('/chat/sessions', { params: { limit, offset } }),

  getSession: (id: string) => api.get(`/chat/sessions/${id}`),

  updateSession: (id: string, title: string) =>
    api.patch(`/chat/sessions/${id}`, { title }),

  deleteSession: (id: string) => api.delete(`/chat/sessions/${id}`),

  getDocuments: () => api.get('/chat/documents'),

  uploadDocument: (data: { title: string; content: string; source?: string; doc_type?: string }) =>
    api.post('/chat/documents', data),

  deleteDocument: (id: string) => api.delete(`/chat/documents/${id}`),
}

// ------------------------------------------------------------------ Admin
export const adminApi = {
  getStats: () => api.get('/admin/stats'),
  listUsers: () => api.get('/admin/users'),
  updateUserRole: (id: string, role: string) =>
    api.patch(`/admin/users/${id}/role`, null, { params: { role } }),
  deactivateUser: (id: string) => api.delete(`/admin/users/${id}`),
  getOrganization: () => api.get('/admin/organization'),
}
