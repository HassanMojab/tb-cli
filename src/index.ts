#!/usr/bin/env node
import axios from 'axios';
import jwtDecode from 'jwt-decode';
import moment from 'moment';
import keytar from 'keytar';
import fs from 'fs';
import fsPromise from 'fs/promises';
import { program } from 'commander';
import path from 'path';
import https from 'https';
import git from 'isomorphic-git';
import * as api from './services/api';
import { prompt } from './utils/prompt';
import gitignore from './data/gitignore';

let account: {
  scopes: ('TENANT_ADMIN' | 'SYS_ADMIN')[];
  userId: string;
  tenantId: string;
};

const configFilePath: string = path.join(
  (process.env.LOCALAPPDATA || process.env.HOME) as string,
  '.tb-cli.config'
);

const readConfigFile = () => {
  try {
    const configFile = fs.readFileSync(configFilePath, { encoding: 'utf8' });
    return JSON.parse(configFile);
  } catch (e) {
    return {};
  }
};

const config = readConfigFile();

const getBaseURL = () => {
  try {
    config.baseURL = new URL('/api', config.baseURL);
    axios.defaults.baseURL = config.baseURL.toString();
    if (config.insecure) {
      axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
    }
  } catch (e) {
    console.log("error: ThingsBoard URL is not set. set it by 'tb set-url <url>'");
    process.exit(1);
  }
};

const setBaseUrl = async (url: string, insecure: boolean) => {
  let tbData = { status: 0, message: '' };
  if (insecure) {
    axios.defaults.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }
  try {
    const { data } = await axios.get(`${url}/api`);
    tbData = data;
  } catch (e) {
    tbData = e.response?.data;
  }
  if (!(tbData?.status === 401) && !(tbData?.message === 'Authentication failed')) {
    console.log('error: provided URL is not for ThingsBoard');
    process.exit(1);
  }
  config.baseURL = url;
  if (insecure) config.insecure = true;
  fs.writeFileSync(configFilePath, JSON.stringify(config));
  config.baseURL = new URL('/api', url);
  console.log(`URL set successfully to "${url}"`);
};

const setToken = (token: string) => {
  account = jwtDecode(token);
  axios.defaults.headers.common = {
    'x-authorization': `Bearer ${token}`,
  };
};

const auth = async () => {
  const token = await keytar.getPassword('tb-token', config.baseURL.host);
  const refreshToken = await keytar.getPassword('tb-refresh-token', config.baseURL.host);

  if (token) {
    const decodedToken: any = jwtDecode(token);
    if (decodedToken.exp > moment().unix() + 60) {
      setToken(token);
    } else if (refreshToken) {
      const decodedRefreshToken: any = jwtDecode(refreshToken);
      if (decodedRefreshToken.exp > moment().unix() + 10) {
        // ! This API call is not working
        try {
          const { data } = await axios.post('/auth/token', { refreshToken });
          await keytar.setPassword('tb-token', config.baseURL.host, data.token);
          await keytar.setPassword('tb-refresh-token', config.baseURL.host, data.refreshToken);
          setToken(data.token);
        } catch (e) {
          console.log('There is a problem to refresh your token. Please login again by "tb login"');
          process.exit(1);
        }
      } else {
        await logout();
        console.log('Login token expired. Please login again by "tb login"');
        process.exit(1);
      }
    } else {
      await logout();
      console.log('Login token expired. Please login again by "tb login"');
      process.exit(1);
    }
  } else {
    console.log('You are not logged in. Please login by "tb login"');
    process.exit(1);
  }
};

const login = async () => {
  try {
    const username = await prompt('Username: ');
    const password = await prompt('Password: ', true);
    const { data } = await axios.post('/auth/login', { username, password });
    await keytar.setPassword('tb-token', config.baseURL.host, data.token);
    await keytar.setPassword('tb-refresh-token', config.baseURL.host, data.refreshToken);
    console.log('You have logged in successfully.');
  } catch (e) {
    console.log(e.response.data.message);
  }
};

const logout = async () => {
  await keytar.deletePassword('tb-token', config.baseURL.host);
  await keytar.deletePassword('tb-refresh-token', config.baseURL.host);
};

// TODO: backup all tenants data -> login and act as sysadmin
// TODO: backup use export/download API
const backup = async (output: string) => {
  let baseDir = output || './backups';
  baseDir = path.join(baseDir, config.baseURL.host);

  await fsPromise.mkdir(baseDir, { recursive: true });

  const gitRoot = await git.findRoot({ fs, filepath: baseDir });
  if (gitRoot !== baseDir) {
    await git.init({ fs, dir: baseDir });

    // TODO: get git configs from user
    await git.setConfig({ fs, dir: baseDir, path: 'user.name', value: 'Hassan Mojab' });
    await git.setConfig({ fs, dir: baseDir, path: 'user.email', value: 'mh_mojab75@yahoo.com' });

    await fsPromise.writeFile(path.join(baseDir, '.gitignore'), gitignore);
  }

  let tenants: {
    id: { id: string };
    name: string;
  }[] = [];

  let tenantTokens = new Map<string, string>();

  if (account.scopes[0] === 'SYS_ADMIN') {
    console.log('******** SysAdmin ********');

    const dirs = ['tenants'];

    await Promise.all(
      dirs.map(
        dir =>
          new Promise<void>((resolve, reject) => {
            const currentDir = path.join(baseDir, dir);
            fsPromise
              .rm(currentDir, { recursive: true, force: true })
              .then(() => {
                fsPromise.mkdir(currentDir).then(resolve);
              })
              .catch(reject);
          })
      )
    );

    let tenantAdmins = new Map<string, string>();

    // Backup Tenants and their Admins
    const backupTenantUsers = (user: any, dir: string) =>
      new Promise<void>((resolve, reject) => {
        api
          .getUserById(user.id.id)
          .then(({ data: userData }) => {
            fsPromise
              .writeFile(
                path.join(dir, `${user.name}.json`),
                JSON.stringify(userData, undefined, 2)
              )
              .then(resolve);
          })
          .catch(e => {
            console.log(e);
            reject(e);
          });
      });

    const backupTenant = (tenant: any) =>
      Promise.all([
        new Promise<void>((resolve, reject) => {
          api
            .getTenantById(tenant.id.id)
            .then(({ data: tenantData }) => {
              fsPromise
                .writeFile(
                  path.join(baseDir, 'tenants', `${tenant.name}.json`),
                  JSON.stringify(tenantData, undefined, 2)
                )
                .then(resolve);
            })
            .catch(e => {
              console.log(e);
              reject(e);
            });
        }),
        new Promise<void>((resolve, reject) => {
          api
            .getEntityUsers('tenant', tenant.id.id)
            .then(({ data: { data: users } }) => {
              tenantAdmins.set(tenant.id.id, users[0]?.id.id);
              const dir = path.join(baseDir, 'tenants', `${tenant.name}`, 'tenantAdmins');
              fsPromise.mkdir(dir, { recursive: true }).then(() => {
                Promise.all(
                  users.map((user: any) => {
                    backupTenantUsers(user, dir);
                  })
                ).then(() => {
                  resolve();
                });
              });
            })
            .catch(e => {
              console.log(e);
              reject(e);
            });
        }),
      ]);

    const backupTenants = new Promise<void>((resolve, reject) => {
      console.log('Backup Tenants...');
      api
        .getTenants()
        .then(({ data }) => {
          tenants = data.data;
          Promise.all(tenants.map(backupTenant)).then(() => {
            console.log('Tenant backup completed!');
            resolve();
          });
        })
        .catch(e => {
          console.log(e);
          reject(e);
        });
    });

    await Promise.all([backupTenants]);

    // Get token of first Tenant Admin of each Tenant
    await Promise.all(
      Array.from(tenantAdmins).map(
        ([tenantId, adminId]: [string, string]) =>
          new Promise<void>((resolve, reject) => {
            api
              .getUserToken(adminId)
              .then(({ data: { token } }) => {
                tenantTokens.set(tenantId, token);
                resolve();
              })
              .catch(e => {
                console.log(e);
                reject(e);
              });
          })
      )
    );
  } else if (account.scopes[0] === 'TENANT_ADMIN') {
    const { data: tenant } = await api.getTenantById(account.tenantId);
    tenants = [tenant];
  } else {
    console.log('Please login with a Tenant or SysAdmin account!');
  }

  for (const tenant of tenants) {
    const token = tenantTokens.get(tenant.id.id);
    if (token) {
      setToken(token);
    }

    console.log(`******** Tenant ${tenant.name} ********`);
    const tenantDir = path.join(baseDir, 'tenants', tenant.name);
    await fsPromise.mkdir(tenantDir, { recursive: true });
    const dirs = ['ruleChains', 'widgets', 'dashboards', 'devices', 'customers'];

    await Promise.all(
      dirs.map(
        dir =>
          new Promise<void>((resolve, reject) => {
            const currentDir = path.join(tenantDir, dir);
            fsPromise
              .rm(currentDir, { recursive: true, force: true })
              .then(() => {
                fsPromise.mkdir(currentDir).then(resolve);
              })
              .catch(reject);
          })
      )
    );

    // Backup Rule Chains
    const backupRuleChain = (ruleChain: any) =>
      new Promise<void>((resolve, reject) => {
        api
          .getRuleChainById(ruleChain.id.id)
          .then(({ data: ruleChainData }) => {
            fsPromise
              .writeFile(
                path.join(tenantDir, 'ruleChains', `${ruleChain.name}.json`),
                JSON.stringify(ruleChainData, undefined, 2)
              )
              .then(resolve);
          })
          .catch(e => {
            console.log(e);
            reject(e);
          });
      });

    const backupRuleChains = new Promise<void>((resolve, reject) => {
      console.log('Backup Rule Chains...');
      api
        .getRuleChains()
        .then(({ data: { data: ruleChains } }) => {
          Promise.all(ruleChains.map(backupRuleChain)).then(() => {
            console.log('Rule Chains backup completed!');
            resolve();
          });
        })
        .catch(e => {
          console.log(e);
          reject(e);
        });
    });

    // Backup widgets
    const backupWidgetBundle = (widgetBundle: any) =>
      new Promise<void>((resolve, reject) => {
        api
          .getWidgetBundlesData(widgetBundle.alias)
          .then(({ data: widgetBundleData }) => {
            fsPromise
              .writeFile(
                path.join(tenantDir, 'widgets', `${widgetBundle.title}.json`),
                JSON.stringify(widgetBundleData, undefined, 2)
              )
              .then(resolve);
          })
          .catch(e => {
            console.log(e);
            reject(e);
          });
      });

    const backupWidgets = new Promise<void>((resolve, reject) => {
      console.log('Backup Widgets...');
      api
        .getWidgetBundles()
        .then(({ data: widgetBundles }) => {
          Promise.all(
            widgetBundles
              .filter((widgetBundle: any) => account.tenantId === widgetBundle.tenantId.id)
              .map(backupWidgetBundle)
          ).then(() => {
            console.log('Widgets backup completed!');
            resolve();
          });
        })
        .catch(e => {
          console.log(e);
          reject(e);
        });
    });

    // Backup Dashboards
    const backupDashboard = (dashboard: any) =>
      new Promise<void>((resolve, reject) => {
        api
          .getDashboardById(dashboard.id.id)
          .then(({ data: dashboardData }) => {
            fsPromise
              .writeFile(
                path.join(tenantDir, 'dashboards', `${dashboard.name}.json`),
                JSON.stringify(dashboardData, undefined, 2)
              )
              .then(resolve);
          })
          .catch(e => {
            console.log(e);
            reject(e);
          });
      });

    const backupDashboards = new Promise<void>((resolve, reject) => {
      console.log('Backup Dashboards...');
      api
        .getDashboards()
        .then(({ data: { data: dashboards } }) => {
          Promise.all(dashboards.map(backupDashboard)).then(() => {
            console.log('Dashboards backup completed!');
            resolve();
          });
        })
        .catch(e => {
          console.log(e);
          reject(e);
        });
    });

    // TODO: backup device data
    // Backup device attributes & access-tokens
    const backupDevice = (device: any) =>
      new Promise<void>((resolve, reject) => {
        const deviceId = device.id.id;
        Promise.all([
          api.getDeviceAttributesByScope(deviceId, 'SERVER_SCOPE'),
          api.getDeviceAttributesByScope(deviceId, 'SHARED_SCOPE'),
          api.getDeviceAttributesByScope(deviceId, 'CLIENT_SCOPE'),
          api.getDeviceCredentials(deviceId),
        ]).then(
          ([
            { data: serverAttributes },
            { data: sharedAttributes },
            { data: clientAttributes },
            { data: credentials },
          ]) => {
            serverAttributes.forEach((item: any) => {
              delete item.lastUpdateTs;
            });
            sharedAttributes.forEach((item: any) => {
              delete item.lastUpdateTs;
            });
            clientAttributes.forEach((item: any) => {
              delete item.lastUpdateTs;
            });

            const attributes = {
              server: serverAttributes,
              shared: sharedAttributes,
              client: clientAttributes,
            };

            const accessToken = credentials.credentialsId;

            fsPromise
              .writeFile(
                path.join(tenantDir, 'devices', `${device.name}.json`),
                JSON.stringify({ accessToken, attributes }, undefined, 2)
              )
              .then(resolve);
          }
        );
      });

    const backupDevices = new Promise<void>((resolve, reject) => {
      console.log('Backup Devices...');
      api
        .getDevices()
        .then(({ data: { data: devices } }) => {
          Promise.all(devices.map(backupDevice)).then(() => {
            console.log('Devices backup completed!');
            resolve();
          });
        })
        .catch(e => {
          console.log(e);
          reject(e);
        });
    });

    // Backup customers and their users
    const backupCustomerUsers = (user: any, dir: string) =>
      new Promise<void>((resolve, reject) => {
        api
          .getUserById(user.id.id)
          .then(({ data: userData }) => {
            fsPromise
              .writeFile(
                path.join(dir, `${user.name}.json`),
                JSON.stringify(userData, undefined, 2)
              )
              .then(resolve);
          })
          .catch(e => {
            console.log(e);
            reject(e);
          });
      });

    const backupCustomer = (customer: any) =>
      Promise.all([
        new Promise<void>((resolve, reject) => {
          api
            .getCustomerById(customer.id.id)
            .then(({ data: customerData }) => {
              fsPromise
                .writeFile(
                  path.join(tenantDir, 'customers', `${customer.name}.json`),
                  JSON.stringify(customerData, undefined, 2)
                )
                .then(resolve);
            })
            .catch(e => {
              console.log(e);
              reject(e);
            });
        }),
        new Promise<void>((resolve, reject) => {
          api
            .getEntityUsers('customer', customer.id.id)
            .then(({ data: { data: users } }) => {
              const dir = path.join(tenantDir, 'customers', `${customer.name}`);
              fsPromise.mkdir(dir).then(() => {
                Promise.all(
                  users.map((user: any) => {
                    backupCustomerUsers(user, dir);
                  })
                ).then(() => {
                  resolve();
                });
              });
            })
            .catch(e => {
              console.log(e);
              reject(e);
            });
        }),
      ]);

    const backupCustomers = new Promise<void>((resolve, reject) => {
      console.log('Backup Customers...');
      api
        .getCustomers()
        .then(({ data: { data: customers } }) => {
          Promise.all(customers.map(backupCustomer)).then(() => {
            console.log('Customers backup completed!');
            resolve();
          });
        })
        .catch(e => {
          console.log(e);
          reject(e);
        });
    });

    await Promise.all([
      backupRuleChains,
      backupWidgets,
      backupDashboards,
      backupDevices,
      backupCustomers,
    ]);
  }

  git.add({ fs, dir: baseDir, filepath: '.' });
  git.commit({
    fs,
    dir: baseDir,
    message: `backup ${moment().format('DD-MM-YYYY HH:mm')}`,
  });

  console.log('done!');
};

const restore = async (dir: string, options: string[]) => {
  if (!dir) {
    console.log(
      'Input directory does not specified. Please ensure to pass the input directory by "-i <directory>".'
    );
    process.exit(1);
  }
  if (!fs.existsSync(dir)) {
    console.log('Input directory does not exist.');
    process.exit(1);
  }

  // TODO: Restore Rule Chains

  // Restore Widgets
  if (options.includes('widgets')) {
    const widgetsDir = path.join(dir, 'widgets');
    if (!fs.existsSync(widgetsDir)) {
      console.log('Input directory does not contain any "widgets/" directory.');
      process.exit(1);
    }

    fsPromise
      .readdir(widgetsDir)
      .then(files => {
        files.forEach(file => {
          const filePath = path.join(widgetsDir, file);
          if (fs.lstatSync(filePath).isFile()) {
            fsPromise.readFile(filePath, 'utf-8').then(async content => {
              try {
                const widgetTypes = JSON.parse(content);
                const widgetsBundleName = file.split('.').slice(0, -1).join('.');
                await api.saveWidgetsBundle({
                  alias: widgetsBundleName.toLowerCase(),
                  image: null,
                  title: widgetsBundleName,
                });
                widgetTypes.forEach(async (widgetType: any) => {
                  delete widgetType.id;
                  delete widgetType.createdTime;
                  delete widgetType.tenantId;
                  await api.saveWidgetType(widgetType);
                });
              } catch (e) {}
            });
          }
        });
      })
      .catch(e => {
        console.log(e);
      });
  }

  // Restore Devices
  if (options.includes('devices')) {
    const devicesDir = path.join(dir, 'devices');
    if (!fs.existsSync(devicesDir)) {
      console.log('Input directory does not contain any "devices/" directory.');
      process.exit(1);
    }

    fsPromise
      .readdir(devicesDir)
      .then(files => {
        files.forEach(file => {
          fsPromise.readFile(path.join(devicesDir, file), 'utf-8').then(async content => {
            try {
              const device = JSON.parse(content);
              const deviceName = file.split('.').slice(0, -1).join('.');

              let deviceId = null;

              try {
                const { data } = await api.saveDevice(
                  {
                    name: deviceName,
                    type: 'AT_CORE',
                  },
                  device.accessToken
                );
                deviceId = data.id.id;
              } catch (e) {
                // If device already exists just restore its accessToken
                if (e.response?.data?.errorCode === 31) {
                  const {
                    data: { data: devices },
                  } = await api.getDevices({ pageSize: 1, textSearch: deviceName });
                  deviceId = devices[0].id.id;
                  try {
                    const { data: credentials } = await api.getDeviceCredentials(deviceId);
                    await api.saveDeviceCredentials({
                      ...credentials,
                      credentialsId: device.accessToken,
                    });
                  } catch (e) {
                    console.log(e.response?.data?.message);
                  }
                } else console.log(e.response?.data?.message);
              }

              const getAttributesObject = (attributesArray: any[]) => {
                const attributesObject: any = {};
                attributesArray.forEach(({ key, value }: { key: string; value: any }) => {
                  attributesObject[key] = value;
                });
                return attributesObject;
              };

              if (device.attributes.server.length > 0) {
                await api.saveDeviceAttributes(
                  deviceId,
                  'SERVER_SCOPE',
                  getAttributesObject(device.attributes.server)
                );
              }
              if (device.attributes.shared.length > 0) {
                await api.saveDeviceAttributes(
                  deviceId,
                  'SHARED_SCOPE',
                  getAttributesObject(device.attributes.shared)
                );
              }
              if (device.attributes.client.length > 0) {
                await api.saveDeviceAttributes(
                  deviceId,
                  'CLIENT_SCOPE',
                  getAttributesObject(device.attributes.client)
                );
              }
            } catch (e) {}
          });
        });
      })
      .catch(e => {
        console.log(e);
      });
  }

  // Restore Dashboards
  if (options.includes('dashboards')) {
    const dashboardsDir = path.join(dir, 'dashboards');
    if (!fs.existsSync(dashboardsDir)) {
      console.log('Input directory does not contain any "dashboards/" directory.');
      process.exit(1);
    }

    fsPromise
      .readdir(dashboardsDir)
      .then(files => {
        files.forEach(file => {
          fsPromise.readFile(path.join(dashboardsDir, file), 'utf-8').then(async content => {
            try {
              const dashboard = JSON.parse(content);
              delete dashboard.id;
              delete dashboard.createdTime;
              delete dashboard.tenantId;

              // TODO: restore entity alias by entity id & for any entity type
              await Promise.all(
                Object.keys(dashboard.configuration.entityAliases).map(async key => {
                  if (
                    dashboard.configuration.entityAliases[key].filter.type === 'singleEntity' &&
                    dashboard.configuration.entityAliases[key].filter.singleEntity.entityType ===
                      'DEVICE'
                  ) {
                    const deviceName = dashboard.configuration.entityAliases[key].alias;
                    const {
                      data: { data: devices },
                    } = await api.getDevices({ pageSize: 1, textSearch: deviceName });
                    if (devices[0]) {
                      dashboard.configuration.entityAliases[key].filter.singleEntity.id =
                        devices[0].id.id;
                      return;
                    }
                  }
                })
              );

              if (dashboard.assignedCustomers) {
                await Promise.all(
                  dashboard.assignedCustomers.map(
                    async ({ title }: { title: string }, index: number) => {
                      const {
                        data: { data: customers },
                      } = await api.getCustomers({ pageSize: 1, textSearch: title });
                      if (customers[0]) {
                        dashboard.assignedCustomers[index].customerId.id = customers[0].id.id;
                        return;
                      }
                      dashboard.assignedCustomers.splice(index, 1);
                    }
                  )
                );
              }

              await api.saveDashboard(dashboard);
            } catch (e) {}
          });
        });
      })
      .catch(e => {
        console.log(e);
      });
  }
};

const clone = async (dashboardName: string, deviceName: string, name?: string) => {
  const {
    data: { data: dashboards },
  } = await api.getDashboards({ pageSize: 1, textSearch: dashboardName });

  if (!dashboards[0]) {
    console.log(`Dashboard ${dashboardName} not found!`);
    process.exit(1);
  }
  const dashboard = dashboards[0];

  const {
    data: { data: devices },
  } = await api.getDevices({ pageSize: 1, textSearch: deviceName });

  if (!devices[0]) {
    console.log(`Device ${deviceName} not found!`);
    process.exit(1);
  }
  const device = devices[0];

  const clonedDashboardName = name || device.name;

  const { data: dashboardData } = await api.getDashboardById(dashboard.id.id);
  const dashboardEntityAliasID = Object.keys(dashboardData.configuration.entityAliases)[0];
  dashboardData.configuration.entityAliases[dashboardEntityAliasID].filter.singleEntity.id =
    device.id.id;
  dashboardData.configuration.entityAliases[dashboardEntityAliasID].alias = device.name;
  dashboardData.name = dashboardData.title = dashboardData.configuration.states.default.name = clonedDashboardName;
  delete dashboardData.id;

  await axios.post('dashboard', dashboardData);

  console.log(`Dashboard ${clonedDashboardName} created successfully`);
};

const label = async (dashboardName: string, deviceName: string) => {
  const {
    data: { data: dashboards },
  } = await api.getDashboards({ pageSize: 1, textSearch: dashboardName });

  if (!dashboards[0]) {
    console.log(`Dashboard ${dashboardName} not found!`);
    process.exit(1);
  }
  const dashboard = dashboards[0];

  const {
    data: { data: devices },
  } = await api.getDevices({ pageSize: 1, textSearch: deviceName });

  if (!devices[0]) {
    console.log(`Device ${deviceName} not found!`);
    process.exit(1);
  }
  const device = devices[0];

  const { data: attributes } = await api.getDeviceAttributes(device.id.id, ['LABELS']);
  const labels = attributes[0].value;

  const { data: dashboardData } = await api.getDashboardById(dashboard.id.id);

  const { widgets } = dashboardData.configuration;

  Object.keys(widgets).forEach(widgetID => {
    const widget = widgets[widgetID];
    if (widget.type === 'rpc') {
      const { valueKey, valueAttribute, method } = widget.config.settings;
      widget.config.showTitle = false;
      widget.config.settings.title =
        labels[valueKey || valueAttribute || method] ?? widget.config.settings.title;
    } else if (widget.type === 'latest' || 'timeseries') {
      if (widget.config.datasources.length === 1) {
        widget.config.title =
          labels[widget.config.datasources[0].dataKeys[0].name] || widget.config.title;
      } else {
        widget.config.datasources.forEach(({ dataKeys }: any, i: number) => {
          dataKeys.forEach(({ name }: { name: string }, j: number) => {
            widget.config.datasources[i].dataKeys[j].label =
              labels[name] || widget.config.datasources[i].dataKeys[j].label;
          });
        });
      }
    }
    widgets[widgetID] = widget;
  });

  dashboardData.configuration.widgets = widgets;

  await axios.post('dashboard', dashboardData);

  console.log(`Dashboard ${dashboardName} labeled successfully`);
};

const convert = async (input: string, output: string) => {
  const baseDir = output || './converts';
  const dir = `${baseDir}/${moment()
    .format('YY-MM-DD HH:mm:ss')
    .replace(/[^0-9]/g, '')}`;

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(`${dir}/ruleChains`);
  fs.mkdirSync(`${dir}/dashboards`);
  fs.mkdirSync(`${dir}/widgets`);

  // Convert Rule Chains
  fsPromise
    .readdir(`${input}/ruleChains`)
    .then(filenames => {
      filenames.forEach(filename => {
        fsPromise.readFile(`${input}/ruleChains/${filename}`, 'utf-8').then(content => {
          const ruleChain = JSON.parse(content);
          delete ruleChain.ruleChainId;
          ruleChain.nodes.forEach((_node: any, index: number) => {
            delete ruleChain.nodes[index].id;
            delete ruleChain.nodes[index].createdTime;
            delete ruleChain.nodes[index].ruleChainId;
          });
          const convertedRuleChain = {
            ruleChain: {
              additionalInfo: null,
              name: path.parse(filename).name,
              firstRuleNodeId: null,
              root: false,
              debugMode: false,
              configuration: null,
            },
            metadata: ruleChain,
          };
          fsPromise.writeFile(`${dir}/ruleChains/${filename}`, JSON.stringify(convertedRuleChain));
        });
      });
    })
    .catch(e => {
      throw e;
    });

  // Convert Dashboards
  fsPromise
    .readdir(`${input}/dashboards`)
    .then(filenames => {
      filenames.forEach(filename => {
        fsPromise.readFile(`${input}/dashboards/${filename}`, 'utf-8').then(content => {
          const dashboard = JSON.parse(content);
          delete dashboard.id;
          delete dashboard.createdTime;
          delete dashboard.tenantId;
          delete dashboard.assignedCustomers;
          fsPromise.writeFile(
            `${dir}/dashboards/${filename}`,
            JSON.stringify(dashboard, undefined, 2)
          );
        });
      });
    })
    .catch(e => {
      throw e;
    });
};

program
  .command('set-url <url>')
  .description('Set ThingsBoard URL')
  .option('-k, --insecure', 'Allow insecure server connections when using SSL')
  .action(async (url: string, cmdObj?: any) => {
    setBaseUrl(url, cmdObj.insecure);
  });

program
  .command('login')
  .description('Login to ThingsBoard')
  .action(async () => {
    getBaseURL();
    await login();
  });

program
  .command('logout')
  .description('logout from ThingsBoard')
  .action(async () => {
    getBaseURL();
    await logout();
  });

program
  .command('backup')
  .option('-o, --output <directory>', 'Directory to store backups')
  .description('Backup Rule Chains, Widgets & Dashboards')
  .action(async (cmdObj?: any) => {
    getBaseURL();
    await auth();
    await backup(cmdObj.output);
  });

program
  .command('restore')
  .option('-i, --input <directory>', 'Directory to restore data from')
  .option('-b, --dashboards', 'Restore dashboards')
  .option('-r, --rulechains', 'Restore rule chains')
  .option('-w, --widgets', 'Restore widgets')
  .option('-d, --devices', 'Restore devices')
  .description('Restore backup data')
  .action(async (cmdObj: any) => {
    getBaseURL();
    await auth();

    const ALL_OPTIONS = ['dashboards', 'rulechains', 'widgets', 'devices'];
    let options = ALL_OPTIONS.filter(option => cmdObj[option]);
    options = options.length > 0 ? options : ALL_OPTIONS;

    await restore(cmdObj.input, options);
  });

program
  .storeOptionsAsProperties(false)
  .command('clone <dashboardName> <deviceName>')
  .option('-n, --name <name>', 'Name of Cloned Dashboard')
  .description('Clone Dashboards')
  .action(async (dashboardName: string, deviceName: string, cmdObj?: any) => {
    getBaseURL();
    await auth();
    await clone(dashboardName.toLowerCase(), deviceName.toLowerCase(), cmdObj.name);
  });

program
  .command('label <dashboardName> <deviceName>')
  .description('Update Dashboard labels')
  .action(async (dashboardName: string, deviceName: string) => {
    getBaseURL();
    await auth();
    await label(dashboardName.toLowerCase(), deviceName.toLowerCase());
  });

program
  .command('convert <input>')
  .option('-o, --output <directory>', 'Directory to store converted data')
  .description('Convert Rule Chains, Widgets & Dashboards from TB v2 to v3')
  .action(async (input: string, cmdObj?: any) => {
    getBaseURL();
    await auth();
    await convert(input, cmdObj.output);
  });

program.parse(process.argv);
