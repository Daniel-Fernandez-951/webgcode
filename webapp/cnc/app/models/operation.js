"use strict";
define(['Ember', 'EmberData', 'cnc/cam/cam', 'cnc/util', 'cnc/cam/operations', 'cnc/cam/toolpath', 'cnc/cam/3D/3Dcomputer', 'require'],
    function (Ember, DS, cam, util, Operations, tp, Computer, require) {
        var attr = DS.attr;
        var operationDefinition = {
            init: function () {
                this._super.apply(this, arguments);
            },

            name: attr('string', {defaultValue: 'New Operation'}),
            index: attr('number', {defaultValue: 0}),
            type: attr('string', {defaultValue: 'SimpleEngravingOperation'}),
            feedrate: attr('number', {defaultValue: 0}),
            feedrateOverride: attr('boolean', {defaultValue: false}),
            enabled: attr('boolean', {defaultValue: true}),
            outline: DS.belongsTo('shape'),
            job: DS.belongsTo('job'),
            task: null,
            installObservers: function () {
                var properties = this.get('operationComputer').properties;
                var _this = this;
                Object.keys(properties).forEach(function (key) {
                    _this.addObserver(key, _this, _this.computeToolpathObeserved)
                });
            }.observes('operationComputer').on('didLoad'),
            uninstallObservers: function () {
                var properties = this.get('operationComputer').properties;
                var _this = this;
                Object.keys(properties).forEach(function (key) {
                    _this.removeObserver(key, _this, _this.computeToolpathObeserved)
                });
            }.observesBefore('operationComputer'),
            computeToolpathObeserved: function () {
                if (this.get('outline.definition') && this.get('type') != '3DlinearOperation')
                    Ember.run.debounce(this, this.computeToolpath, 100);
            }.observes('type', 'outline.polyline', 'job.toolDiameter', 'job.safetyZ', 'outline.manualDefinition.x', 'outline.manualDefinition.y').on('init'),
            computeToolpath: function () {
                var _this = this;
                if (this.get('type')) {
                    var params = this.getComputingParameters();
                    var previousWorker = _this.get('toolpathWorker');
                    if (previousWorker)
                        previousWorker.terminate();
                    _this.set('toolpath', null);
                    _this.set('missedArea', null);
                    var worker = new Worker(require.toUrl('worker.js'));
                    worker.onmessage = Ember.run.bind(this, function (event) {
                        _this.get('toolpathWorker').terminate();
                        _this.set('toolpathWorker', null);
                        _this.set('toolpath', event.data.toolpath.map(function (p) {
                            return tp.decodeToolPath(p)
                        }));
                        _this.set('missedArea', event.data.missedArea.map(function (polys) {
                            return polys.map(function (poly) {
                                return poly.map(function (point) {
                                    return new util.Point(point.x, point.y, 0);
                                });
                            });
                        }));
                    });
                    worker.onerror = Ember.run.bind(this, function (error) {
                        _this.set('toolpathWorker', null);
                        console.log(error);
                    });
                    worker.postMessage({
                        operation: 'computeToolpath',
                        params: params
                    });
                    this.set('toolpathWorker', worker);
                }
            },
            compute3D: function (safetyZ, toolDiameter) {
                var _this = this;
                var model = this.get('outline.meshGeometry');
                var leaveStock = this.get('3d_leaveStock');
                var topZ = this.get('top_Z');
                var sliceZ = this.get('3d_slice_Z');
                var minZ = this.get('bottom_Z');
                var tool = this.get('tool');
                var orientation = this.get('3d_pathOrientation');
                var stepover = this.get('3d_diametralEngagement') * toolDiameter / 100;
                var startRatio = this.get('3d_startPercent') / 100;
                var stopRatio = this.get('3d_stopPercent') / 100;
                var computer = new Computer.ToolPathComputer();
                var task = computer.computeHeightField(model, stepover, tool, leaveStock, orientation,
                    startRatio, stopRatio);
                this.set('task', task);
                task.addObserver('isDone', function () {
                    _this.set('task', null);
                });
                task.get('promise')
                    .then(function (heightField) {
                        return Computer.convertHeightFieldToToolPath(heightField, safetyZ, topZ, sliceZ, minZ);
                    })
                    .then(Ember.run.bind(this, function (result) {
                        _this.set('toolpath', result);
                    }));
                task.start();
            },
            computing: function () {
                return (this.get('task') && !this.get('task.isDone')) || this.get('toolpathWorker');
            }.property('task', 'task.isDone', 'toolpathWorker'),
            paused: function () {
                console.log('computing', this.get('task') && !this.get('task.isDone'));
                return this.get('task.isPaused');
            }.property('task', 'task.isPaused'),
            tool: function () {
                return {
                    type: this.get('3d_toolType'),
                    diameter: this.get('job.toolDiameter'),
                    angle: this.get('3d_vToolAngle'),
                    tipDiameter: this.get('3d_vToolTipDiameter')
                };
            }.property('3d_toolType', 'job.toolDiameter', '3d_vToolAngle', '3d_vToolTipDiameter'),
            actualFeedrate: function () {
                if (this.get('feedrateOverride')) {
                    var f = this.get('feedrate');
                    return f == 0 ? this.get('job.feedrate') : f;
                } else return this.get('job.feedrate');
            }.property('feedrate', 'job.feedrate', 'feedrateOverride'),
            operationComputer: function () {
                return Operations[this.get('type')];
            }.property('type'),
            getComputingParameters: function () {
                var operation = this.get('operationComputer');
                var params = {
                    job: {
                        safetyZ: this.get('job.safetyZ'),
                        toolDiameter: this.get('job.toolDiameter'),
                        offsetX: this.get('job.offsetX'),
                        offsetY: this.get('job.offsetY')
                    },
                    outline: {
                        flipped: this.get('outline.flipped'),
                        clipperPolyline: this.get('outline.clipperPolyline'),
                        point: {
                            x: this.get('outline.manualDefinition.x'),
                            y: this.get('outline.manualDefinition.y')
                        },
                        drillData: this.get('outline.drillData')
                    },
                    type: this.get('type')
                };
                var _this = this;
                Object.keys(operation.properties).forEach(function (key) {
                    params[key] = _this.get(key);
                });
                return params;
            }
        };

//add all the attributes from all the operations types
        for (var opName in Operations) {
            var op = Operations[opName];
            for (var attrName in op.properties) {
                var definition = op.properties[attrName];
                operationDefinition[attrName] = attr(definition.type, definition.options);
            }
        }

        /**
         * Here is the deal: the Operation grabs the tool at startPoint for X and Y and on the safety plane,
         * at zero speed, zero inertia.
         * Operation releases the tool at stopPoint, at the Z it wants at zero speed and zero inertia, but the document will
         * pull the tool along Z+ to the safety plane, so dovetail tools or slotting tools better be out at the end of the operation.
         * The Job does the travel before, in between and after the operations.
         * When this works we can try to be smarter and not stop uselessly.
         */

        return DS.Model.extend(operationDefinition);
    });