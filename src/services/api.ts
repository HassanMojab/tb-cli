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
  axios.get('/ruleChains', { params });
export const getRuleChainById = (id: string) => axios.get(`/ruleChain/${id}/metadata`);

// Widgets
export const getWidgetBundles = () => axios.get('/widgetsBundles');
export const getWidgetBundlesData = (alias: string, isSystem: boolean) =>
  axios.get(`widgetTypes?isSystem=${isSystem}&bundleAlias=${alias}`);

// Dashboards
export const getDashboards = (params: GetListParams = DEFAULT_GET_LIST_PARAMS) =>
  axios.get('/tenant/dashboards', { params });
export const getDashboardById = (id: string) => axios.get(`/dashboard/${id}`);

// Devices
export const getDevices = (params: GetListParams = DEFAULT_GET_LIST_PARAMS) =>
  axios.get('/tenant/devices', { params });
export const getDeviceCredentials = (id: string) => axios.get(`/device/${id}/credentials`);

// Attributes
export const getDeviceAttributesByScope = (id: string, scope: AttributesScope) =>
  axios.get(`/plugins/telemetry/DEVICE/${id}/values/attributes/${scope}`);
export const getDeviceAttributes = (id: string, keys: string[] = []) =>
  axios.get(`/plugins/telemetry/DEVICE/${id}/values/attributes?keys=${keys.join(',')}`);