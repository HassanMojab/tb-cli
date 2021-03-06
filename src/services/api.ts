import axios from 'axios';

// TODO add type for UUID string

type AttributesScope = 'SERVER_SCOPE' | 'SHARED_SCOPE' | 'CLIENT_SCOPE';
type GetListParams = {
  pageSize?: number;
  page?: number;
  textSearch?: string;
};

const DEFAULT_GET_LIST_PARAMS = {
  pageSize: 1000,
  page: 0,
};

// Rule Chains
export const getRuleChains = (params: GetListParams = DEFAULT_GET_LIST_PARAMS) =>
  axios.get('/ruleChains', { params: { page: 0, ...params } });
export const getRuleChainById = (id: string) => axios.get(`/ruleChain/${id}/metadata`);

// Widgets
export const getWidgetBundles = () => axios.get('/widgetsBundles');
export const getWidgetBundlesData = (alias: string, isSystem: boolean = false) =>
  axios.get(`widgetTypes?isSystem=${isSystem}&bundleAlias=${alias}`);
export const saveWidgetsBundle = (widgetsBundle: any) => axios.post('widgetsBundle', widgetsBundle);
export const saveWidgetType = (widgetType: any) => axios.post('widgetType', widgetType);

// Dashboards
export const getDashboards = (params: GetListParams = DEFAULT_GET_LIST_PARAMS) =>
  axios.get('/tenant/dashboards', { params: { page: 0, ...params } });
export const getDashboardById = (id: string) => axios.get(`/dashboard/${id}`);
export const saveDashboard = (dashboard: any) => axios.post('/dashboard', dashboard);

// Devices
export const getDevices = (params: GetListParams = DEFAULT_GET_LIST_PARAMS) =>
  axios.get('/tenant/devices', { params: { page: 0, ...params } });
export const saveDevice = (device: any, accessToken?: string) =>
  axios.post('/device', device, {
    params: {
      accessToken,
    },
  });
export const getDeviceCredentials = (id: string) => axios.get(`/device/${id}/credentials`);
export const saveDeviceCredentials = (credentials: any) =>
  axios.post('/device/credentials', credentials);

// Attributes
export const getDeviceAttributesByScope = (
  id: string,
  scope: AttributesScope,
  keys: string[] = []
) => axios.get(`/plugins/telemetry/DEVICE/${id}/values/attributes/${scope}?keys=${keys.join(',')}`);
export const getDeviceAttributes = (id: string, keys: string[] = []) =>
  axios.get(`/plugins/telemetry/DEVICE/${id}/values/attributes?keys=${keys.join(',')}`);
export const saveDeviceAttributes = (id: string, scope: AttributesScope, attributes: any) =>
  axios.post(`/plugins/telemetry/${id}/${scope}`, attributes);

// Customers
export const getCustomers = (params: GetListParams = DEFAULT_GET_LIST_PARAMS) =>
  axios.get('/customers', { params: { page: 0, ...params } });
export const getCustomerById = (id: string) => axios.get(`/customer/${id}`);

// Users
export const getEntityUsers = (
  entity: 'customer' | 'tenant',
  entityId: string,
  params: GetListParams = DEFAULT_GET_LIST_PARAMS
) => axios.get(`/${entity}/${entityId}/users`, { params: { page: 0, ...params } });
export const getUserById = (id: string) => axios.get(`/user/${id}`);
export const getUserToken = (id: string) => axios.get(`/user/${id}/token`);

// Tenants
export const getTenants = (params: GetListParams = DEFAULT_GET_LIST_PARAMS) =>
  axios.get('/tenantInfos', { params: { page: 0, ...params } });
export const getTenantById = (id: string) => axios.get(`/tenant/${id}`);


