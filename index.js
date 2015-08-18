var path = require('path');
var through = require('through2');
var convert = require('convert-source-map');
var sm = require('source-map');
var crypto = require('crypto');
var fs = require('fs');
var _ = require('lodash');
var RSVP = require('rsvp');

function has(object, propName) {
  return Object.prototype.hasOwnProperty.call(object, propName);
}

function hash(str) {
  var hasher = crypto.createHash('sha256');
  hasher.update(str);
  return hasher.digest('base64').slice(0, 20);
}

var readManagerTemplate = _.once(function() {
  return new RSVP.Promise(function(resolve, reject) {
    fs.readFile(path.join(__dirname, 'hmr-manager-template.js'), 'utf8', function(err, data) {
      if (err)
        reject(err);
      else
        resolve(data);
    });
  });
});

var validUpdateModes = ['xhr', 'fs'];
var updateModesNeedingUrl = ['xhr'];

module.exports = function(bundle, opts) {
  if (!opts) opts = {};
  var updateMode = opts.mode||opts.m||'xhr';
  var updateUrl = opts.url||opts.u||null;
  var updateCacheBust = Boolean(has(opts, 'cacheBust') ? opts.cacheBust : has(opts, 'b') ? opts.b : true);

  if (!_.includes(validUpdateModes, updateMode)) {
    throw new Error("Invalid mode "+updateMode);
  }
  if (!updateUrl && _.includes(updateModesNeedingUrl, updateMode)) {
    throw new Error("url option must be specified for "+updateMode+" mode");
  }

  var hmrManagerFilename;

  function setupPipelineMods() {
    var originalEntries = [];
    bundle.pipeline.get('record').push(through.obj(function(row, enc, next) {
      if (row.entry) {
        originalEntries.push(row.file);
        next(null);
      } else {
        next(null, row);
      }
    }, function(next) {
      var source = originalEntries.map(function(name) {
        return 'require('+JSON.stringify(name)+');\n';
      }).join('');

      // Put the hmr file name in the same directory as an entry file in order
      // to prevent this: https://github.com/babel/babelify/issues/85
      hmrManagerFilename = path.join(path.dirname(originalEntries[0]), '__hmr_manager.js');
      this.push({
        entry: true,
        expose: false,
        basedir: undefined,
        file: hmrManagerFilename,
        id: hmrManagerFilename,
        source: source,
        order: 0
      });
      next();
    }));

    var moduleMeta = {};

    function makeModuleMetaEntry(name) {
      if (!has(moduleMeta, name)) {
        moduleMeta[name] = {
          index: null,
          hash: null,
          parents: []
        };
      }
    }

    bundle.pipeline.get('deps').push(through.obj(function(row, enc, next) {
      if (row.file !== hmrManagerFilename) {
        makeModuleMetaEntry(row.file);
        _.forOwn(row.deps, function(name, ref) {
          // dependencies that aren't included in the bundle have the name false
          if (name) {
            makeModuleMetaEntry(name);
            moduleMeta[name].parents.push(row.file);
          }
        });
      }
      next(null, row);
    }));

    bundle.pipeline.get('syntax').push(through.obj(function(row, enc, next) {
      if (row.file === hmrManagerFilename) {
        next(null, row);
      } else {
        var header = '_hmr.initModule('+JSON.stringify(row.file)+', module);\n(function(){\n';
        var footer = '\n}).call(this, arguments);\n';

        var inputMapConsumer;
        var inputMap = convert.fromSource(row.source);
        if (inputMap) {
          inputMapConsumer = new sm.SourceMapConsumer(inputMap.toObject());
          row.source = convert.removeComments(row.source);
        }
        var outputMapGenerator = new sm.SourceMapGenerator({
          file: row.file
        });
        var lines = row.source.split('\n').length;
        for (var i=1; i<=lines; i++) {
          outputMapGenerator.addMapping({
            generated: {line:i+2,column:0},
            original: {line:i,column:0},
            source: row.file
          });
        }
        outputMapGenerator.setSourceContent(row.file, row.source);
        if (inputMapConsumer) {
          outputMapGenerator.applySourceMap(inputMapConsumer);
        }
        var mergedMap = outputMapGenerator.toJSON();
        if (inputMap) {
          mergedMap.sources = inputMap.sources || [inputMap.file ? inputMap.file : row.file];
          mergedMap.file = inputMap.file;
        }
        row.source = header + row.source + footer +
          '\n' + convert.fromObject(mergedMap).toComment();
        next(null, row);
      }
    }));

    var labelRows = [];
    var managerRow = null;
    bundle.pipeline.get('label').push(through.obj(function(row, enc, next) {
      if (row.file !== hmrManagerFilename) {
        // row.id used when fullPaths flag is used
        moduleMeta[row.file].index = has(row, 'index') ? row.index : row.id;
        moduleMeta[row.file].hash = hash(row.source);
        labelRows.push(row);
      } else {
        managerRow = row;
      }
      next(null);
    }, function(done) {
      var self = this;
      readManagerTemplate().then(function(mgrTemplate) {
        managerRow.source = mgrTemplate
          .replace('null/*!^^moduleMeta*/', JSON.stringify(moduleMeta))
          .replace('null/*!^^originalEntries*/', JSON.stringify(originalEntries))
          .replace('null/*!^^updateUrl*/', JSON.stringify(updateUrl))
          .replace('null/*!^^updateMode*/', JSON.stringify(updateMode))
          .replace('null/*!^^updateCacheBust*/', JSON.stringify(updateCacheBust));
        self.push(managerRow);
        labelRows.forEach(function(row) {
          self.push(row);
        });
      }).then(done, done);
    }));
  }
  setupPipelineMods();

  bundle.on('reset', setupPipelineMods);
};
