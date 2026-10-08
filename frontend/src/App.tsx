import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { authApi } from '@/services/api'

import LoginPage from '@/pages/LoginPage'
import RegisterPage from '@/pages/RegisterPage'
import ChatPage from '@/pages/ChatPage'
import AdminPage from '@/pages/AdminPage'
import ProtectedRoute from '@/components/ProtectedRoute'

export default function App() {
  const { isAuthenticated, setUser, logout } = useAuthStore()

  useEffect(() => {
    if (isAuthenticated) {
      authApi.me()
        .then((res) => setUser(res.data))
        .catch(() => logout())
    }
  }, [])

  return (
    <Routes>
      <Route path="/login" element={
        isAuthenticated ? <Navigate to="/chat" replace /> : <LoginPage />
      } />
      <Route path="/register" element={
        isAuthenticated ? <Navigate to="/chat" replace /> : <RegisterPage />
      } />
      <Route path="/chat" element={
        <ProtectedRoute><ChatPage /></ProtectedRoute>
      } />
      <Route path="/chat/:sessionId" element={
        <ProtectedRoute><ChatPage /></ProtectedRoute>
      } />
      <Route path="/admin" element={
        <ProtectedRoute adminOnly><AdminPage /></ProtectedRoute>
      } />
      <Route path="/" element={<Navigate to={isAuthenticated ? "/chat" : "/login"} replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
