import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App as AntApp, ConfigProvider, Result, Spin } from 'antd'
import viVN from 'antd/locale/vi_VN'
import dayjs from 'dayjs'
import 'dayjs/locale/vi'
import { lazy, Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from '../auth/AuthProvider'
import { LoginPage } from '../auth/LoginPage'
import { Loading, Need } from '../components/common'
import { AdminLayout } from './AdminLayout'

dayjs.locale('vi')

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, retry: 1, refetchOnWindowFocus: false } },
})

const lazyNamed = <K extends string>(loader: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => loader().then((m) => ({ default: m[name] })))

const DashboardPage = lazyNamed(() => import('../features/dashboard/DashboardPage'), 'DashboardPage')
const BookingListPage = lazyNamed(() => import('../features/bookings/BookingListPage'), 'BookingListPage')
const BookingDetailPage = lazyNamed(() => import('../features/bookings/BookingDetailPage'), 'BookingDetailPage')
const DeparturesPage = lazyNamed(() => import('../features/departures/DeparturesPage'), 'DeparturesPage')
const OperationsBoardPage = lazyNamed(() => import('../features/operations/OperationsBoardPage'), 'OperationsBoardPage')
const DepartureWorkspacePage = lazyNamed(() => import('../features/operations/DepartureWorkspacePage'), 'DepartureWorkspacePage')
const ToursPage = lazyNamed(() => import('../features/catalog/ToursPage'), 'ToursPage')
const CustomersPage = lazyNamed(() => import('../features/customers/CustomersPage'), 'CustomersPage')
const GuidesPage = lazyNamed(() => import('../features/resources/ResourcesPages'), 'GuidesPage')
const VehiclesPage = lazyNamed(() => import('../features/resources/ResourcesPages'), 'VehiclesPage')
const FinancePage = lazyNamed(() => import('../features/finance/FinancePage'), 'FinancePage')
const ConnectionsPage = lazyNamed(() => import('../features/connections/ConnectionsPage'), 'ConnectionsPage')
const ImportPage = lazyNamed(() => import('../features/imports/ImportPage'), 'ImportPage')
const ReportsPage = lazyNamed(() => import('../features/reports/ReportsPage'), 'ReportsPage')
const AuditPage = lazyNamed(() => import('../features/audit/AuditPage'), 'AuditPage')
const SettingsPage = lazyNamed(() => import('../features/settings/SettingsPage'), 'SettingsPage')
const GuideListPage = lazyNamed(() => import('../features/guide-portal/GuidePortal'), 'GuideListPage')
const GuideDeparturePage = lazyNamed(() => import('../features/guide-portal/GuidePortal'), 'GuideDeparturePage')

function Home() {
  const { can } = useAuth()
  return <Navigate to={can('booking.read') ? '/dashboard' : can('guide.portal') ? '/guide' : '/forbidden'} replace />
}

function Gate() {
  const { session, ready, orgs, orgsLoading, orgsError, can, signOut } = useAuth()

  if (!ready || (session && orgsLoading)) {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}><Spin size="large" /></div>
  }
  if (!session) return <LoginPage />
  if (orgsError || orgs.length === 0) {
    return (
      <Result status={orgsError ? 'error' : 'warning'}
        title={orgsError ? 'Không tải được thông tin tài khoản' : 'Tài khoản chưa thuộc doanh nghiệp nào'}
        subTitle="Liên hệ quản trị viên để được cấp quyền."
        extra={<a onClick={() => void signOut()}>Đăng xuất</a>} />
    )
  }

  const page = (perm: string | string[], el: React.ReactNode) => <Need perm={perm}>{el}</Need>

  // Hướng dẫn viên không vào vỏ quản trị: màn hình riêng, ưu tiên điện thoại.
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/guide" element={page(['guide.portal', 'ops.manage'], <GuideListPage />)} />
        <Route path="/guide/:id" element={page(['guide.portal', 'ops.manage'], <GuideDeparturePage />)} />
        <Route element={can('guide.portal') && !can('booking.read') ? <Navigate to="/guide" replace /> : <AdminLayout />}>
          <Route path="/dashboard" element={page('booking.read', <DashboardPage />)} />
          <Route path="/bookings" element={page('booking.read', <BookingListPage />)} />
          <Route path="/bookings/:id" element={page('booking.read', <BookingDetailPage />)} />
          <Route path="/departures" element={page('departure.read', <DeparturesPage />)} />
          <Route path="/operations" element={page('ops.read', <OperationsBoardPage />)} />
          <Route path="/operations/:id" element={page(['ops.read', 'departure.read'], <DepartureWorkspacePage />)} />
          <Route path="/tours" element={page('catalog.read', <ToursPage />)} />
          <Route path="/customers" element={page('customer.read', <CustomersPage />)} />
          <Route path="/guides" element={page('resource.read', <GuidesPage />)} />
          <Route path="/vehicles" element={page('resource.read', <VehiclesPage />)} />
          <Route path="/finance" element={page('finance.read', <FinancePage />)} />
          <Route path="/connections" element={page('connection.read', <ConnectionsPage />)} />
          <Route path="/imports" element={page('import.manage', <ImportPage />)} />
          <Route path="/reports" element={page('report.read', <ReportsPage />)} />
          <Route path="/audit" element={page('audit.read', <AuditPage />)} />
          <Route path="/settings" element={page(['member.manage', 'org.manage', 'catalog.manage'], <SettingsPage />)} />
          <Route path="*" element={<Result status="404" title="Không tìm thấy trang" />} />
        </Route>
      </Routes>
    </Suspense>
  )
}

export function App() {
  return (
    <ConfigProvider locale={viVN} theme={{ token: { colorPrimary: '#0f766e', borderRadius: 6, colorBgLayout: '#f5f6f8' } }}>
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthProvider>
              <Gate />
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  )
}
