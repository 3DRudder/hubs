const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const selfsigned = require("selfsigned");
const webpack = require("webpack");
const cors = require("cors");
const HTMLWebpackPlugin = require("html-webpack-plugin");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const BundleAnalyzerPlugin = require("webpack-bundle-analyzer").BundleAnalyzerPlugin;
const TOML = require("@iarna/toml");
const fetch = require("node-fetch");
const request = require("request");

function createHTTPSConfig() {
  // Generate certs for the local webpack-dev-server.
  if (fs.existsSync(path.join(__dirname, "certs"))) {
    const key = fs.readFileSync(path.join(__dirname, "certs", "key.pem"));
    const cert = fs.readFileSync(path.join(__dirname, "certs", "cert.pem"));

    return { key, cert };
  } else {
    const pems = selfsigned.generate(
      [
        {
          name: "commonName",
          value: "localhost"
        }
      ],
      {
        days: 365,
        keySize: 2048,
        algorithm: "sha256",
        extensions: [
          {
            name: "subjectAltName",
            altNames: [
              {
                type: 2,
                value: "localhost"
              },
              {
                type: 2,
                value: "hubs.local"
              }
            ]
          }
        ]
      }
    );

    fs.mkdirSync(path.join(__dirname, "certs"));
    fs.writeFileSync(path.join(__dirname, "certs", "cert.pem"), pems.cert);
    fs.writeFileSync(path.join(__dirname, "certs", "key.pem"), pems.private);

    return {
      key: pems.private,
      cert: pems.cert
    };
  }
}

function matchRegex({ include, exclude }) {
  return (module, chunks) => {
    if (
      module.nameForCondition &&
      include.test(module.nameForCondition()) &&
      !exclude.test(module.nameForCondition())
    ) {
      return true;
    }
    for (const chunk of chunks) {
      if (chunk.name && include.test(chunk.name) && !exclude.test(chunk.name)) {
        return true;
      }
    }
    return false;
  };
}

function createDefaultAppConfig() {
  const schemaPath = path.join(__dirname, "src", "schema.toml");
  const schemaString = fs.readFileSync(schemaPath).toString();

  let appConfigSchema;

  try {
    appConfigSchema = TOML.parse(schemaString);
  } catch (e) {
    console.error("Error parsing schema.toml on line " + e.line + ", column " + e.column + ": " + e.message);
    throw e;
  }

  const appConfig = {};

  for (const [categoryName, category] of Object.entries(appConfigSchema)) {
    appConfig[categoryName] = {};

    // Enable all features with a boolean type
    if (categoryName === "features") {
      for (const [key, schema] of Object.entries(category)) {
        if (key === "require_account_for_join") {
          appConfig[categoryName][key] = false;
        } else {
          appConfig[categoryName][key] = schema.type === "boolean" ? true : null;
        }
      }
    }
  }

  return appConfig;
}

async function fetchAppConfigAndEnvironmentVars() {
  if (!fs.existsSync(".ret.credentials")) {
    throw new Error("Not logged in to Hubs Cloud. Run `npm login` first.");
  }

  const { host, token } = JSON.parse(fs.readFileSync(".ret.credentials"));

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };

  // Load the Hubs Cloud instance's app config in development
  const appConfigsResponse = await fetch(`https://${host}/api/v1/app_configs`, { headers });

  if (!appConfigsResponse.ok) {
    throw new Error(`Error fetching Hubs Cloud config "${appConfigsResponse.statusText}"`);
  }

  const appConfig = await appConfigsResponse.json();

  // dev.reticulum.io doesn't run ita
  if (host === "dev.reticulum.io") {
    return appConfig;
  }

  const hubsConfigsResponse = await fetch(`https://${host}/api/ita/configs/hubs`, { headers });

  const hubsConfigs = await hubsConfigsResponse.json();

  if (!hubsConfigsResponse.ok) {
    throw new Error(`Error fetching Hubs Cloud config "${hubsConfigsResponse.statusText}"`);
  }

  const { shortlink_domain, thumbnail_server } = hubsConfigs.general;

  process.env.RETICULUM_SERVER = host;
  process.env.SHORTLINK_DOMAIN = shortlink_domain;
  process.env.CORS_PROXY_SERVER = "localhost:8080/cors-proxy";
  process.env.THUMBNAIL_SERVER = thumbnail_server;
  process.env.NON_CORS_PROXY_DOMAINS = "hubs.local,localhost";

  return appConfig;
}

module.exports = async (env, argv) => {
  env = env || {};

  // Load environment variables from .env files.
  // .env takes precedent over .defaults.env
  // Previously defined environment variables are not overwritten
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".defaults.env" });

  let appConfig = undefined;

  /**
   * Initialize the Webpack build envrionment for the provided environment.
   */

  if (argv.mode !== "production" || env.bundleAnalyzer) {
    if (env.loadAppConfig || process.env.LOAD_APP_CONFIG) {
      if (!env.localDev) {
        // Load and set the app config and environment variables from the remote server.
        // A Hubs Cloud server or dev.reticulum.io can be used.
        appConfig = await fetchAppConfigAndEnvironmentVars();
      }
    } else {
      // Use the default app config with all featured enabled.
      appConfig = createDefaultAppConfig();
    }

    if (env.localDev) {
      // Local Dev Environment (npm run local)
      Object.assign(process.env, {
        HOST: "hubs.local",
        RETICULUM_SOCKET_SERVER: "hubs.local",
        CORS_PROXY_SERVER: "hubs-proxy.local:4000",
        NON_CORS_PROXY_DOMAINS: "hubs.local,dev.reticulum.io",
        BASE_ASSETS_PATH: "https://hubs.local:8080/",
        RETICULUM_SERVER: "hubs.local:4000",
        POSTGREST_SERVER: "",
        ITA_SERVER: ""
      });
    }
  }

  // In production, the environment variables are defined in CI or loaded from ita and
  // the app config is injected into the head of the page by Reticulum.

  const host = process.env.HOST_IP || env.localDev ? "hubs.local" : "localhost";

  // Remove comments from .babelrc
  const babelConfig = JSON.parse(
    fs
      .readFileSync(path.resolve(__dirname, ".babelrc"))
      .toString()
      .replace(/\/\/.+/g, "")
  );

  return {
    node: {
      // need to specify this manually because some random lodash code will try to access
      // Buffer on the global object if it exists, so webpack will polyfill on its behalf
      Buffer: false,
      fs: "empty"
    },
    externals: ['ws'],
    entry: {
      index: path.join(__dirname, "src", "index.js"),
      hub: path.join(__dirname, "src", "hub.js"),
      scene: path.join(__dirname, "src", "scene.js"),
      avatar: path.join(__dirname, "src", "avatar.js"),
      link: path.join(__dirname, "src", "link.js"),
      discord: path.join(__dirname, "src", "discord.js"),
      cloud: path.join(__dirname, "src", "cloud.js"),
      "whats-new": path.join(__dirname, "src", "whats-new.js")
    },
    output: {
      filename: "assets/js/[name]-[chunkhash].js",
      publicPath: process.env.BASE_ASSETS_PATH || ""
    },
    devtool: argv.mode === "production" ? "source-map" : "inline-source-map",
    devServer: {
      https: createHTTPSConfig(),
      host: "0.0.0.0",
      public: `${host}:8080`,
      useLocalIp: true,
      allowedHosts: [host, "hubs.local"],
      headers: {
        "Access-Control-Allow-Origin": "*"
      },
      before: function(app) {
        // Local CORS proxy
        app.all("/cors-proxy/*", (req, res) => {
          res.header("Access-Control-Allow-Origin", "*");
          res.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          res.header("Access-Control-Allow-Headers", "Range");
          res.header(
            "Access-Control-Expose-Headers",
            "Accept-Ranges, Content-Encoding, Content-Length, Content-Range, Hub-Name, Hub-Entity-Type"
          );
          res.header("Vary", "Origin");
          res.header("X-Content-Type-Options", "nosniff");

          const redirectLocation = req.header("location");

          if (redirectLocation) {
            res.header("Location", "https://localhost:8080/cors-proxy/" + redirectLocation);
          }

          if (req.method === "OPTIONS") {
            res.send();
          } else {
            const url = req.path.replace("/cors-proxy/", "");
            request({ url, method: req.method }, error => {
              if (error) {
                console.error(`cors-proxy: error fetching "${url}"\n`, error);
                return;
              }
            }).pipe(res);
          }
        });

        // be flexible with people accessing via a local reticulum on another port
        app.use(cors({ origin: /hubs\.local(:\d*)?$/ }));
        // networked-aframe makes HEAD requests to the server for time syncing. Respond with an empty body.
        app.head("*", function(req, res, next) {
          if (req.method === "HEAD") {
            res.append("Date", new Date().toGMTString());
            res.send("");
          } else {
            next();
          }
        });
      }
    },
    performance: {
      // Ignore media and sourcemaps when warning about file size.
      assetFilter(assetFilename) {
        return !/\.(map|png|jpg|gif|glb|webm)$/.test(assetFilename);
      }
    },
    module: {
      rules: [
        {
          test: /\.html$/,
          loader: "html-loader",
          options: {
            // <a-asset-item>'s src property is overwritten with the correct transformed asset url.
            attrs: ["img:src", "a-asset-item:src", "audio:src", "source:src"]
          }
        },
        {
          test: /\.worker\.js$/,
          loader: "worker-loader",
          options: {
            name: "assets/js/[name]-[hash].js",
            publicPath: "/",
            inline: true
          }
        },
        {
          // We reference the sources of some libraries directly, and they use async/await,
          // so we have to run it through babel in order to support the Samsung browser on Oculus Go.
          test: [path.resolve(__dirname, "node_modules/naf-janus-adapter")],
          loader: "babel-loader",
          options: babelConfig
        },
        {
          test: /\.js$/,
          include: [path.resolve(__dirname, "src")],
          // Exclude JS assets in node_modules because they are already transformed and often big.
          exclude: [path.resolve(__dirname, "node_modules")],
          loader: "babel-loader"
        },
        {
          test: /\.(scss|css)$/,
          use: [
            {
              loader: MiniCssExtractPlugin.loader
            },
            {
              loader: "css-loader",
              options: {
                name: "[path][name]-[hash].[ext]",
                localIdentName: "[name]__[local]__[hash:base64:5]",
                camelCase: true
              }
            },
            "sass-loader"
          ]
        },
        {
          test: /\.(png|jpg|gif|glb|ogg|mp3|mp4|wav|woff2|svg|webm)$/,
          use: {
            loader: "file-loader",
            options: {
              // move required assets to output dir and add a hash for cache busting
              name: "[path][name]-[hash].[ext]",
              // Make asset paths relative to /src
              context: path.join(__dirname, "src")
            }
          }
        },
        {
          test: /\.(svgi)$/,
          use: {
            loader: "svg-inline-loader"
          }
        },
        {
          test: /\.(wasm)$/,
          type: "javascript/auto",
          use: {
            loader: "file-loader",
            options: {
              outputPath: "assets/wasm",
              name: "[name]-[hash].[ext]"
            }
          }
        },
        {
          test: /\.(glsl|frag|vert)$/,
          use: { loader: "raw-loader" }
        }
      ]
    },

    optimization: {
      splitChunks: {
        cacheGroups: {
          vendors: {
            test: matchRegex({
              include: /([\\/]node_modules[\\/]|[\\/]vendor[\\/])/,
              exclude: /[\\/]node_modules[\\/]markdown-it[\\/]/
            }),
            priority: 50,
            name: "vendor",
            chunks: "all"
          },
          engine: {
            test: /([\\/]src[\\/]workers|[\\/]node_modules[\\/](aframe|cannon|three))/,
            priority: 100,
            name: "engine",
            chunks: "all"
          }
        }
      }
    },
    plugins: [
      new BundleAnalyzerPlugin({
        analyzerMode: env && env.BUNDLE_ANALYZER ? "server" : "disabled"
      }),
      // Each output page needs a HTMLWebpackPlugin entry
      new HTMLWebpackPlugin({
        filename: "index.html",
        template: path.join(__dirname, "src", "index.html"),
        chunks: ["vendor", "index"]
      }),
      new HTMLWebpackPlugin({
        filename: "hub.html",
        template: path.join(__dirname, "src", "hub.html"),
        chunks: ["vendor", "engine", "hub"],
        inject: "head"
      }),
      new HTMLWebpackPlugin({
        filename: "scene.html",
        template: path.join(__dirname, "src", "scene.html"),
        chunks: ["vendor", "engine", "scene"],
        inject: "head"
      }),
      new HTMLWebpackPlugin({
        filename: "avatar.html",
        template: path.join(__dirname, "src", "avatar.html"),
        chunks: ["vendor", "engine", "avatar"],
        inject: "head"
      }),
      new HTMLWebpackPlugin({
        filename: "link.html",
        template: path.join(__dirname, "src", "link.html"),
        chunks: ["vendor", "engine", "link"]
      }),
      new HTMLWebpackPlugin({
        filename: "discord.html",
        template: path.join(__dirname, "src", "discord.html"),
        chunks: ["vendor", "discord"]
      }),
      new HTMLWebpackPlugin({
        filename: "whats-new.html",
        template: path.join(__dirname, "src", "whats-new.html"),
        chunks: ["vendor", "whats-new"],
        inject: "head"
      }),
      new HTMLWebpackPlugin({
        filename: "cloud.html",
        template: path.join(__dirname, "src", "cloud.html"),
        chunks: ["vendor", "cloud"],
        inject: "head"
      }),
      new CopyWebpackPlugin([
        {
          from: "src/hub.service.js",
          to: "hub.service.js"
        }
      ]),
      new CopyWebpackPlugin([
        {
          from: "src/schema.toml",
          to: "schema.toml"
        }
      ]),
      // Extract required css and add a content hash.
      new MiniCssExtractPlugin({
        filename: "assets/stylesheets/[name]-[contenthash].css",
        disable: argv.mode !== "production"
      }),
      // Define process.env variables in the browser context.
      new webpack.DefinePlugin({
        "process.env": JSON.stringify({
          NODE_ENV: argv.mode,
          SHORTLINK_DOMAIN: process.env.SHORTLINK_DOMAIN,
          RETICULUM_SERVER: process.env.RETICULUM_SERVER,
          RETICULUM_SOCKET_SERVER: process.env.RETICULUM_SOCKET_SERVER,
          THUMBNAIL_SERVER: process.env.THUMBNAIL_SERVER,
          CORS_PROXY_SERVER: process.env.CORS_PROXY_SERVER,
          NON_CORS_PROXY_DOMAINS: process.env.NON_CORS_PROXY_DOMAINS,
          BUILD_VERSION: process.env.BUILD_VERSION,
          SENTRY_DSN: process.env.SENTRY_DSN,
          GA_TRACKING_ID: process.env.GA_TRACKING_ID,
          POSTGREST_SERVER: process.env.POSTGREST_SERVER,
          APP_CONFIG: appConfig
        })
      })
    ]
  };
};
