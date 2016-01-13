module.exports = Builder;

var async = require('async');
var child_process = require('child_process');
var fs = require('fs');
var path = require('path');
var https = require('https');
var concat = require('./concat.js');
var Uglify = require('./uglify.js');
var OpalCompiler = require('./opal-compiler.js');
var Log = require('./log.js');
var uglify = new Uglify();
var opalCompiler = new OpalCompiler();
var log = new Log();

var stdout;

String.prototype.endsWith = function(suffix) {
  return this.indexOf(suffix, this.length - suffix.length) !== -1;
};

var deleteFolderRecursive = function(path) {
  var files = [];
  if (fs.existsSync(path)) {
    files = fs.readdirSync(path);
    files.forEach(function(file,index){
      var curPath = path + "/" + file;
      if (fs.lstatSync(curPath).isDirectory()) { // recurse
        deleteFolderRecursive(curPath);
      } else { // delete file
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(path);
  }
};

var walk = function(currentDirPath, callback) {
  fs.readdirSync(currentDirPath).forEach(function(name) {
    var filePath = path.join(currentDirPath, name);
    var stat = fs.statSync(filePath);
    if (stat.isFile()) {
      callback(filePath, stat);
    } else if (stat.isDirectory()) {
      walk(filePath, callback);
    }
  });
};

var javaVersionText = function() {
  var result = child_process.execSync('java -version 2>&1', {encoding: 'utf8'});
  var firstLine = result.split('\n')[0];
  var javaVersion = firstLine.match(/"(.*?)"/i)[1];
  return javaVersion.replace(/\./g, '').replace(/_/g, '');
}


function Builder() {
  this.npmCoreFiles = [
    'src/npm/prepend-core.js',
    'build/asciidoctor-core.js'
  ];
  this.examplesBuildDir = 'build/examples';
  this.examplesImagesBuildDir = this.examplesBuildDir + '/images';
  var asciidocRepoURI = 'https://raw.githubusercontent.com/asciidoc/asciidoc';
  var asciidocRepoHash = 'd43faae38c4a8bf366dcba545971da99f2b2d625';
  this.asciidocRepoBaseURI = asciidocRepoURI + '/' + asciidocRepoHash;
}

Builder.prototype.build = function(callback) {
  if (process.env.DRY_RUN) {
    log.debug('build');
    callback();
    return;
  }
  var builder = this;
  var start = process.hrtime();

  // Step 1: clean
  builder.clean();

  // Step 2: build
  builder.buildRuby();

  // Step 3: concat
  builder.concatJavaScripts();

  async.series([
    function(callback) {
      builder.uglify(callback); // Step 4: Uglify (optional)
    }
  ], function() {
    log.success('Done in ' + process.hrtime(start)[0] + 's');
    typeof callback === 'function' && callback();
  });
}

Builder.prototype.clean = function() {
  log.title('clean');
  this.deleteBuildFolder(); // delete build folder
}

Builder.prototype.buildRuby = function() {
  log.title('build');
  this.execSync('bundle install');
  this.execSync('bundle exec rake dist');
}

Builder.prototype.concatJavaScripts = function() {
  log.title('concat');
  this.concatCore();
  this.concatCoreMin();
  this.concatNpmExtensions();
  this.concatNpmDocbook();
  this.concatBowerCoreExtensions();
  this.concatBowerDocbook();
  this.concatBowerAll();
  this.concatBowerCore(); // must be the last because we're using 'build/asciidoctor-core.js' in other concat tasks
}

Builder.prototype.release = function(releaseVersion) {
  var builder = this;
  var start = process.hrtime();

  async.series([
    function(callback) { builder.prepareRelease(releaseVersion, callback); },
    function(callback) { builder.build(callback); },
    function(callback) { builder.runTest(callback); },
    function(callback) { builder.copyToDist(callback); },
    function(callback) { builder.uglify(callback); },
    function(callback) { builder.commit(releaseVersion, callback); },
    function(callback) { builder.prepareNextIteration(callback); },
    function(callback) { builder.publish(callback); },
    function(callback) { builder.completeRelease(releaseVersion, callback); }
  ], function() {
    log.success('Done in ' + process.hrtime(start)[0] + 's');
  });
}

Builder.prototype.prepareRelease = function(releaseVersion, callback) {
  log.title('Release version: ' + releaseVersion);

  if (process.env.DRY_RUN) {
    log.warn('Dry run! To perform the release, run the command again without DRY_RUN environment variable');
  }

  this.replaceFileSync('package.json', /"version": "(.*?)"/g, '"version": "' + releaseVersion + '"');
  this.replaceFileSync('bower.json', /"version": "(.*?)"/g, '"version": "' + releaseVersion + '"');
  callback();
}

Builder.prototype.commit = function(releaseVersion, callback) {
  this.execSync('git add -A .');
  this.execSync('git commit -m "Release ' + releaseVersion + '"');
  this.execSync('git tag v' + releaseVersion);
  callback();
}

Builder.prototype.prepareNextIteration = function(callback) {
  this.deleteDistFolder();
  this.execSync('git add -A .');
  this.execSync('git commit -m "Prepare for next development iteration');
  callback();
}

Builder.prototype.runTest = function(callback) {
  this.execSync('npm run test');
  callback();
}

Builder.prototype.publish = function(callback) {
  if (process.env.SKIP_PUBLISH) {
    log.info('SKIP_PUBLISH environment variable is defined, skipping "publish" task');
    callback();
    return;
  } 
  this.execSync('npm publish');
  callback();
}

Builder.prototype.completeRelease = function(releaseVersion, callback) {
  console.log('');
  log.info('To complete the release, you need to:');
  log.info("[ ] push changes upstream: 'git push origin master && git push origin v" + releaseVersion + "'");
  log.info("[ ] publish a release page on GitHub: https://github.com/asciidoctor/asciidoctor.js/releases/new");
  log.info('[ ] create an issue here: https://github.com/webjars/asciidoctor.js to update Webjars');
  callback();
}

Builder.prototype.concat = function(message, files, destination) {
  log.debug(message);
  concat(files, destination);
}

Builder.prototype.concatCore = function() {
  this.concat('npm core', this.npmCoreFiles.concat(['src/npm/append-core.js']), 'build/npm/asciidoctor-core.js');
}

Builder.prototype.concatCoreMin = function() {
  this.concat('npm core.min', this.npmCoreFiles.concat(['src/npm/append-core-min.js']), 'build/npm/asciidoctor-core-min.js');
}

Builder.prototype.concatNpmExtensions = function() {
  var files = [
    'src/npm/prepend-extensions.js',
    'build/asciidoctor-extensions.js',
    'src/append-require-extensions.js',
    'src/npm/append-extensions.js'
  ];
  this.concat('npm extensions', files, 'build/npm/asciidoctor-extensions.js');
}

Builder.prototype.concatNpmDocbook = function() {
  var files = [
    'src/npm/prepend-extensions.js',
    'build/asciidoctor-docbook45.js',
    'build/asciidoctor-docbook5.js',
    'src/append-require-docbook.js',
    'src/npm/append-extensions.js'
  ];
  this.concat('npm docbook', files, 'build/npm/asciidoctor-docbook.js');
}

Builder.prototype.concatBowerCoreExtensions = function() {
  var files = [
    'build/asciidoctor-core.js',
    'build/asciidoctor-extensions.js',
    'src/append-require-core.js',
    'src/append-require-extensions.js'
  ];
  this.concat('Bower core + extensions', files, 'build/asciidoctor.js');
}

Builder.prototype.concatBowerDocbook = function() {
  var files = [
    'build/asciidoctor-docbook45.js',
    'build/asciidoctor-docbook5.js',
    'src/append-require-docbook.js'
  ];
  this.concat('Bower docbook', files, 'build/asciidoctor-docbook.js');
}

Builder.prototype.concatBowerAll = function() {
  var files = [
    'bower_components/opal/opal/current/opal.js',
    'build/asciidoctor-core.js',
    'build/asciidoctor-extensions.js',
    'src/append-require-core.js',
    'src/append-require-extensions.js'
  ];
  this.concat('Bower all', files, 'build/asciidoctor-all.js');
}

Builder.prototype.concatBowerCore = function() {
  var files = [
    'build/asciidoctor-core.js',
    'src/append-require-core.js'
  ];
  this.concat('Bower core', files, 'build/asciidoctor-core.js');
}

Builder.prototype.deleteBuildFolder = function() {
  log.debug('delete build directory');
  deleteFolderRecursive('build');
  fs.mkdirSync('build');
  fs.mkdirSync('build/npm');
}

Builder.prototype.deleteDistFolder = function() {
  log.debug('delete dist directory');
  deleteFolderRecursive('dist');
  fs.mkdirSync('dist');
  fs.mkdirSync('dist/css');
  fs.mkdirSync('dist/npm');
}

Builder.prototype.replaceFileSync = function(file, regexp, newSubString) {
  log.debug('update ' + file);
  if (!process.env.DRY_RUN) {
    var data = fs.readFileSync(file, 'utf8');
    var dataUpdated = data.replace(regexp, newSubString);
    fs.writeFileSync(file, dataUpdated, 'utf8');
  }
}

Builder.prototype.execSync = function(command) {
  log.debug(command);
  if (!process.env.DRY_RUN) {
    stdout = child_process.execSync(command);
    process.stdout.write(stdout);
  }
}

Builder.prototype.uglify = function(callback) {
  // Preconditions
  // - MINIFY environment variable is defined
  if (!process.env.MINIFY) {
    log.info('MINIFY environment variable is not defined, skipping "minify" task');
    callback();
    return;
  }
  // - Java7 or higher is available in PATH
  try {
    if (javaVersionText() < '170') {
      log.warn('Closure Compiler requires Java7 or higher, skipping "minify" task');
      callback();
      return;
    }
  } catch (e) {
    log.warn('\'java\' binary is not available in PATH, skipping "minify" task');
    callback();
    return;
  }
  log.title('uglify');
  var files = [
    {source: 'build/npm/asciidoctor-core-min.js', destination: 'build/npm/asciidoctor-core.min.js' },
    {source: 'build/npm/asciidoctor-extensions.js', destination: 'build/npm/asciidoctor-extensions.min.js' },
    {source: 'build/npm/asciidoctor-docbook.js', destination: 'build/npm/asciidoctor-docbook.min.js' },
    {source: 'build/asciidoctor-core.js', destination: 'build/asciidoctor-core.min.js' },
    {source: 'build/asciidoctor-extensions.js', destination: 'build/asciidoctor-extensions.min.js' },
    {source: 'build/asciidoctor-docbook.js', destination: 'build/asciidoctor-docbook.min.js' },
    {source: 'build/asciidoctor-all.js', destination: 'build/asciidoctor-all.min.js' }
  ];

  var functions = [];

  var tasks = [];
  files.forEach(function(file) {
    var source = file.source;
    var destination = file.destination;
    log.transform('minify', source, destination);
    tasks.push(function(callback) { uglify.minify(source, destination, callback) });
  });
  async.parallelLimit(tasks, 4, callback);
}

Builder.prototype.copyToDist = function(callback) {
  log.title('copy to dist/')
  this.deleteDistFolder();
  this.copy('build/asciidoctor.css', 'dist/css/asciidoctor.css');
  walk('build', function(filePath, stat) {
    var basename = path.basename(filePath);
    var paths = path.dirname(filePath).split(path.sep);
    if (filePath.endsWith('.js')
         && paths.indexOf('examples') == -1
         && filePath.indexOf('spec') == -1
         && !filePath.endsWith('-min.js')
         && !filePath.endsWith('-docbook45.js') 
         && !filePath.endsWith('-docbook5.js')) {
      // remove 'build' base directory
      paths.shift();
      // add 'dist' base directory
      paths.unshift('dist');
      paths.push(basename);
      var destination = paths.join(path.sep);
      this.copy(filePath, destination);
    }
  });
  typeof callback === 'function' && callback();
}

Builder.prototype.copyToExamplesBuildDir = function(file) {
  this.copyToDir(file, this.examplesBuildDir);
}

Builder.prototype.copyToExamplesImagesBuildDir = function(file) {
  this.copyToDir(file, this.examplesImagesBuildDir);
}

Builder.prototype.copyToDir = function(from, toDir) {
  var basename = path.basename(from);
  this.copy(from, toDir + '/' + basename);
}

Builder.prototype.copy = function(from, to) {
  log.transform('copy', from, to);
  fs.createReadStream(from).pipe(fs.createWriteStream(to));
}

Builder.prototype.mkdirSync = function(path) {
  if (!fs.existsSync(path)) {
    fs.mkdirSync(path);
  }
}

Builder.prototype.examples = function(callback) {
  var builder = this;
  
  async.series([
    function(callback) {
      builder.build(callback); // Step 1: Build
    },
    function(callback) {
      builder.compileExamples(callback); // Step 2: Compile examples
    },
    function(callback) {
      builder.copyExamplesResources(callback); // Step 3: Copy examples resources
    }
  ], function() {
    log.success('You can now open build/examples/asciidoctor_example.html and build/examples/userguide_test.html');
    typeof callback === 'function' && callback();
  });
}

Builder.prototype.compileExamples = function(callback) {
  log.title('compile examples');
  this.mkdirSync(this.examplesBuildDir);
  opalCompiler.compile('examples/asciidoctor_example.rb', this.examplesBuildDir + '/asciidoctor_example.js');
  opalCompiler.compile('examples/userguide_test.rb', this.examplesBuildDir + '/userguide_test.js');
  callback();
}

Builder.prototype.fetchAsciiDocContent = function(source, target, callback) {
  log.transform('fetch', source, target);
  var targetStream = fs.createWriteStream(target);
  var request = https.get(this.asciidocRepoBaseURI + '/doc/' + source, function(response) {
    response.pipe(targetStream);
    callback();
  });
}

Builder.prototype.copyExamplesResources = function(callback) {
  var builder = this;

  log.title('copy resources to ' + this.examplesBuildDir + '/');
  this.copyToExamplesBuildDir('examples/asciidoctor_example.html');
  this.copyToExamplesBuildDir('examples/userguide_test.html');
  this.copyToExamplesBuildDir('examples/asciidoctor.css');
  this.copyToExamplesBuildDir('README.adoc');

  log.title('copy images to ' + this.examplesImagesBuildDir + '/');
  this.mkdirSync(this.examplesBuildDir + '/images');
  this.copyToExamplesImagesBuildDir('error-in-chrome-console.png');
  this.copyToExamplesImagesBuildDir('error-in-javascript-debugger.png');

  log.title('fetch content from AsciiDoc repository');
  async.series([
    function(callback) {
      builder.fetchAsciiDocContent('asciidoc.txt', builder.examplesBuildDir + '/userguide.adoc', callback);
    },
    function(callback) {
      builder.fetchAsciiDocContent('customers.csv', builder.examplesBuildDir + '/customers.csv', callback);
    }
  ], function() {
    typeof callback === 'function' && callback();
  });
}
