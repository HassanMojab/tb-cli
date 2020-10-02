#!/usr/bin/env node
import axios from 'axios';
import jwtDecode from 'jwt-decode';
import moment from 'moment';
import keytar from 'keytar';
import fs from 'fs';
import { program } from 'commander';
import path from 'path';
import * as api from './services/api';

let account: {
  tenantId: string;
};

const configFilePath: string = path.join(
  (process.env.LOCALAPPDATA || process.env.HOME) as string,
  '.tb-cli.config'
);

const readConfigFile = () => {
  let configFile = '{}';
  try {
    configFile = fs.readFileSync(configFilePath, { encoding: 'utf8' });
  } catch (e) {}
  return JSON.parse(configFile);
};

const config = readConfigFile();

const getBaseURL = () => {
  try {
    config.baseURL = new URL('/api', config.baseURL);
    axios.defaults.baseURL = config.baseURL.toString();
  } catch (e) {
    console.log("error: ThingsBoard URL is not set. set it by 'tb set-url <url>'");
    process.exit(1);
  }
};

const setBaseUrl = async (url: string) => {
  let tbData = { status: 0, message: '' };
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
  fs.writeFileSync(configFilePath, JSON.stringify(config));
  config.baseURL = new URL('/api', url);
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
          console.log(
            'There is a problem to refresh your token. Please login again by "tb login <username> <password>"'
          );
          process.exit(1);
        }
      } else {
        await logout();
        console.log('Login token expired. Please login again by "tb login <username> <password>"');
        process.exit(1);
      }
    } else {
      await logout();
      console.log('Login token expired. Please login again by "tb login <username> <password>"');
      process.exit(1);
    }
  } else {
    console.log('You are not logged in. Please login by "tb login <username> <password>"');
    process.exit(1);
  }
};

const login = async (username: string, password: string) => {
  try {
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

const backup = async (output: string) => {
  const baseDir = output || './backups';
  const dir = `${baseDir}/${config.baseURL.host}/${moment()
    .format('YY-MM-DD HH:mm:ss')
    .replace(/[^0-9]/g, '')}`;

  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(`${dir}/ruleChains`);
  fs.mkdirSync(`${dir}/widgets`);
  fs.mkdirSync(`${dir}/dashboards`);
  fs.mkdirSync(`${dir}/devices`);

  // Backup Rule Chains
  const {
    data: { data: ruleChains },
  } = await api.getRuleChains();

  ruleChains.forEach(async (ruleChain: any) => {
    const { data: ruleChainData } = await api.getRuleChainById(ruleChain.id.id);
    fs.writeFile(
      `${dir}/ruleChains/${ruleChain.name}.json`,
      JSON.stringify(ruleChainData),
      (err: any) => {
        if (err) throw err;
        // console.log(`Rule "${ruleChain.name}" Saved!`);
      }
    );
  });

  // Backup widgets
  const { data: widgetBundles } = await api.getWidgetBundles();

  widgetBundles.forEach(async (widgetBundle: any) => {
    const { data: widgetBundleData } = await api.getWidgetBundlesData(
      widgetBundle.alias,
      account.tenantId !== widgetBundle.tenantId.id
    );
    fs.writeFile(
      `${dir}/widgets/${widgetBundle.title}.json`,
      JSON.stringify(widgetBundleData),
      (err: any) => {
        if (err) throw err;
      }
    );

    const widgetsDir = `${dir}/widgets/${widgetBundle.title}`;
    fs.mkdirSync(widgetsDir);
    widgetBundleData.forEach((widget: any) => {
      fs.writeFile(`${widgetsDir}/${widget.name}.json`, JSON.stringify(widget), (err: any) => {
        if (err) throw err;
      });
    });
  });

  // Backup Dashboards
  const {
    data: { data: dashboards },
  } = await api.getDashboards();

  dashboards.forEach(async (dashboard: any) => {
    const { data: dashboardData } = await api.getDashboardById(dashboard.id.id);
    fs.writeFile(
      `${dir}/dashboards/${dashboard.name}.json`,
      JSON.stringify(dashboardData),
      (err: any) => {
        if (err) throw err;
      }
    );
  });

  // TODO: backup device data
  // Backup device attributes & access-tokens
  const {
    data: { data: devices },
  } = await api.getDevices();

  devices.forEach(async (device: any) => {
    const deviceId = device.id.id;
    const { data: serverAttributes } = await api.getDeviceAttributesByScope(
      deviceId,
      'SERVER_SCOPE'
    );
    serverAttributes.forEach((item: any) => {
      delete item.lastUpdateTs;
    });

    const { data: sharedAttributes } = await api.getDeviceAttributesByScope(
      deviceId,
      'SHARED_SCOPE'
    );
    sharedAttributes.forEach((item: any) => {
      delete item.lastUpdateTs;
    });

    const { data: clientAttributes } = await api.getDeviceAttributesByScope(
      deviceId,
      'CLIENT_SCOPE'
    );
    clientAttributes.forEach((item: any) => {
      delete item.lastUpdateTs;
    });

    const attributes = {
      server: serverAttributes,
      shared: sharedAttributes,
      client: clientAttributes,
    };

    const { data: credentials } = await api.getDeviceCredentials(deviceId);

    const accessToken = credentials.credentialsId;

    fs.writeFile(
      `${dir}/devices/${device.name}.json`,
      JSON.stringify({
        accessToken,
        attributes,
      }),
      (err: any) => {
        if (err) throw err;
      }
    );
  });
};

const restore = async (dir: string, options: string[]) => {
  const restoreAll = options.length === 0;

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

  // Restore Dashboards
  if (restoreAll || options.includes('dashboards')) {
    const dashboardsDir = path.join(dir, 'dashboards');
    if (!fs.existsSync(dashboardsDir)) {
      console.log('Input directory does not contain any "dashboards/" directory.');
      process.exit(1);
    }
  }

  // Restore Devices
  if (restoreAll || options.includes('devices')) {
    const devicesDir = path.join(dir, 'devices');
    if (!fs.existsSync(devicesDir)) {
      console.log('Input directory does not contain any "devices/" directory.');
      process.exit(1);
    }

    fs.readdir(devicesDir, (err, files) => {
      if (err) console.log(err);
      else {
        files.forEach(file => {
          try {
            fs.readFile(path.join(devicesDir, file), 'utf-8', async (err, content) => {
              if (err) console.log(err);
              else {
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
                  // If device already exists just restore its accessToke
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
              }
            });
          } catch (e) {}
        });
      }
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
  const labels = JSON.parse(attributes[0].value);

  const { data: dashboardData } = await api.getDashboardById(dashboard.id.id);

  const { widgets } = dashboardData.configuration;

  Object.keys(widgets).forEach(widgetID => {
    const widget = widgets[widgetID];
    if (widget.type === 'rpc') {
      const { valueKey, valueAttribute } = widget.config.settings;
      widget.config.title = labels[valueKey || valueAttribute];
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
  fs.readdir(`${input}/ruleChains`, (err, filenames) => {
    if (err) {
      throw err;
    }
    filenames.forEach(filename => {
      fs.readFile(`${input}/ruleChains/${filename}`, 'utf-8', (err, content) => {
        if (err) {
          throw err;
        }
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
        fs.writeFile(
          `${dir}/ruleChains/${filename}`,
          JSON.stringify(convertedRuleChain),
          (err: any) => {
            if (err) throw err;
          }
        );
      });
    });
  });

  // Convert Dashboards
  fs.readdir(`${input}/dashboards`, (err, filenames) => {
    if (err) {
      throw err;
    }
    filenames.forEach(filename => {
      fs.readFile(`${input}/dashboards/${filename}`, 'utf-8', (err, content) => {
        if (err) {
          throw err;
        }
        const dashboard = JSON.parse(content);
        delete dashboard.id;
        delete dashboard.createdTime;
        delete dashboard.tenantId;
        delete dashboard.assignedCustomers;
        fs.writeFile(`${dir}/dashboards/${filename}`, JSON.stringify(dashboard), (err: any) => {
          if (err) throw err;
        });
      });
    });
  });
};

program
  .command('set-url <url>')
  .description('Set ThingsBoard URL')
  .action(async (url: string) => {
    setBaseUrl(url);
  });

program
  .command('login <username> <password>')
  .description('Login to ThingsBoard')
  .action(async (username: string, password: string) => {
    getBaseURL();
    await login(username, password);
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
  .option('-d, --dashboards', 'Restore dashboards')
  .option('-r, --rulechains', 'Restore rule chains')
  .option('-w, --widgets', 'Restore widgets')
  .option('-d, --devices', 'Restore devices')
  .description('Restore backup data')
  .action(async (cmdObj: any) => {
    let options = ['dashboards', 'rulechains', 'widgets', 'devices'];
    options.forEach(option => {
      if (cmdObj[option]) options.filter(e => e !== option);
    });

    getBaseURL();
    await auth();
    await restore(cmdObj.input, options);
  });

program
  .passCommandToAction(false)
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
