/* jshint ignore:start */
'use strict';

const BbPromise = require('bluebird');
const fse = require('fs-extra');
const values = require('lodash.values');
const {
  addVendorHelper,
  removeVendorHelper,
  packRequirements,
} = require('./lib/zip');
const { injectAllRequirements } = require('./lib/inject');
const { layerRequirements } = require('./lib/layer');
const { installAllRequirements } = require('./lib/pip');
const { pipfileToRequirements } = require('./lib/pipenv');
const { cleanup, cleanupCache } = require('./lib/clean');
BbPromise.promisifyAll(fse);

/**
 * Plugin for Serverless 1.x that bundles python requirements!
 */
class ServerlessPythonRequirements {
  /**
   * get the custom.pythonRequirements contents, with defaults set
   * @return {Object}
   */
  get options() {
    const options = Object.assign(
      {
        slim: false,
        slimPatterns: false,
        slimPatternsAppendDefaults: true,
        zip: false,
        layer: false,
        cleanupZipHelper: true,
        invalidateCaches: false,
        fileName: 'requirements.txt',
        usePipenv: true,
        usePoetry: true,
        pythonBin:
          process.platform === 'win32'
            ? 'python.exe'
            : this.serverless.service.provider.runtime || 'python',
        dockerizePip: false,
        dockerSsh: false,
        dockerPrivateKey: null,
        dockerImage: null,
        dockerFile: null,
        dockerEnv: false,
        dockerBuildCmdExtraArgs: [],
        dockerRunCmdExtraArgs: [],
        dockerExtraFiles: [],
        dockerRootless: false,
        useStaticCache: true,
        useDownloadCache: true,
        cacheLocation: false,
        staticCacheMaxVersions: 0,
        pipCmdExtraArgs: [],
        noDeploy: [],
        vendor: '',
        requirePoetryLockFile: false,
        poetryWithGroups: [],
        poetryWithoutGroups: [],
        poetryOnlyGroups: [],
      },
      (this.serverless.service.custom &&
        this.serverless.service.custom.pythonRequirements) ||
        {}
    );
    if (
      options.pythonBin === this.serverless.service.provider.runtime &&
      !options.pythonBin.startsWith('python')
    ) {
      options.pythonBin = 'python';
    }
    if (/python3[0-9]+/.test(options.pythonBin)) {
      // "google" and "scaleway" providers' runtimes use python3XX
      options.pythonBin = options.pythonBin.replace(/3([0-9]+)/, '3.$1');
    }
    if (options.dockerizePip === 'non-linux') {
      options.dockerizePip = process.platform !== 'linux';
    }
    if (options.dockerizePip && process.platform === 'win32') {
      options.pythonBin = 'python';
    }
    if (
      !options.dockerizePip &&
      (options.dockerSsh ||
        options.dockerImage ||
        options.dockerFile ||
        options.dockerPrivateKey)
    ) {
      if (!this.warningLogged) {
        if (this.log) {
          this.log.warning(
            'You provided a docker related option but dockerizePip is set to false.'
          );
        } else {
          this.serverless.cli.log(
            'WARNING: You provided a docker related option but dockerizePip is set to false.'
          );
        }
        this.warningLogged = true;
      }
    }
    if (options.dockerImage && options.dockerFile) {
      throw new Error(
        'Python Requirements: you can provide a dockerImage or a dockerFile option, not both.'
      );
    }

    if (options.layer) {
      // If layer was set as a boolean, set it to an empty object to use the layer defaults.
      if (options.layer === true) {
        options.layer = {};
      }
    }
    return options;
  }

  get targetFuncs() {
    let inputOpt = this.serverless.processedInput.options;
    return inputOpt.function
      ? [this.serverless.service.functions[inputOpt.function]]
      : values(this.serverless.service.functions).filter((func) => !func.image);
  }

  /**
   * The plugin constructor
   * @param {Object} serverless
   * @param {Object} options
   * @param {Object} v3Utils
   * @return {undefined}
   */
  constructor(serverless, cliOptions, v3Utils) {
    this.serverless = serverless;
    this.servicePath = this.serverless.config.servicePath;
    this.warningLogged = false;
    if (
      this.serverless.configSchemaHandler &&
      this.serverless.configSchemaHandler.defineFunctionProperties
    ) {
      this.serverless.configSchemaHandler.defineFunctionProperties('aws', {
        properties: {
          module: {
            type: 'string',
          },
        },
      });
    }

    if (v3Utils) {
      this.log = v3Utils.log;
      this.progress = v3Utils.progress;
      this.writeText = v3Utils.writeText;
    }

    this.commands = {
      requirements: {
        commands: {
          clean: {
            usage: 'Remove .requirements and requirements.zip',
            lifecycleEvents: ['clean'],
          },
          install: {
            usage: 'install requirements manually',
            lifecycleEvents: ['install'],
          },
          cleanCache: {
            usage:
              'Removes all items in the pip download/static cache (if present)',
            lifecycleEvents: ['cleanCache'],
          },
        },
      },
    };

    if (this.serverless.cli.generateCommandsHelp) {
      Object.assign(this.commands.requirements, {
        usage: 'Serverless plugin to bundle Python packages',
        lifecycleEvents: ['requirements'],
      });
    } else {
      this.commands.requirements.type = 'container';
    }

    this.dockerImageForFunction = (funcOptions) => {
      const runtime =
        funcOptions.runtime || this.serverless.service.provider.runtime;

      const architecture =
        funcOptions.architecture ||
        this.serverless.service.provider.architecture ||
        'x86_64';
      const defaultImage = `public.ecr.aws/sam/build-${runtime}:latest-${architecture}`;
      return this.options.dockerImage || defaultImage;
    };

    const isFunctionRuntimePython = (args) => {
      // If functionObj.runtime is undefined, python.
      if (!args[1].functionObj || !args[1].functionObj.runtime) {
        return true;
      }
      return args[1].functionObj.runtime.startsWith('python');
    };

    const clean = () =>
      BbPromise.bind(this).then(cleanup).then(removeVendorHelper);

    const setupArtifactPathCapturing = () => {
      // Reference:
      // https://github.com/serverless/serverless/blob/9591d5a232c641155613d23b0f88ca05ea51b436/lib/plugins/package/lib/packageService.js#L139
      // The packageService#packageFunction does set artifact path back to the function config.
      // As long as the function config's "package" attribute wasn't undefined, we can still use it
      // later to access the artifact path.
      for (const functionName in this.serverless.service.functions) {
        if (!serverless.service.functions[functionName].package) {
          serverless.service.functions[functionName].package = {};
        }
      }
    };

    const before = () => {
      if (!isFunctionRuntimePython(arguments)) {
        return;
      }
      return BbPromise.bind(this)
        .then(pipfileToRequirements)
        .then(addVendorHelper)
        .then(installAllRequirements)
        .then(packRequirements)
        .then(setupArtifactPathCapturing);
    };

    const after = () => {
      if (!isFunctionRuntimePython(arguments)) {
        return;
      }
      return BbPromise.bind(this)
        .then(removeVendorHelper)
        .then(layerRequirements)
        .then(() =>
          injectAllRequirements.bind(this)(
            arguments[1].functionObj &&
              arguments[1].functionObj.package.artifact
          )
        );
    };

    const invalidateCaches = () => {
      if (this.options.invalidateCaches) {
        return clean;
      }
      return BbPromise.resolve();
    };

    const cleanCache = () => BbPromise.bind(this).then(cleanupCache);

    this.hooks = {
      'after:package:cleanup': invalidateCaches,
      'before:package:createDeploymentArtifacts': before,
      'after:package:createDeploymentArtifacts': after,
      'before:deploy:function:packageFunction': before,
      'after:deploy:function:packageFunction': after,
      'requirements:requirements': () => {
        this.serverless.cli.generateCommandsHelp(['requirements']);
        return BbPromise.resolve();
      },
      'requirements:install:install': before,
      'requirements:clean:clean': clean,
      'requirements:cleanCache:cleanCache': cleanCache,
    };
  }
}

module.exports = ServerlessPythonRequirements;
