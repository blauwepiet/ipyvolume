var _ = require('underscore')
var widgets = require('@jupyter-widgets/base');
var THREE = require('three')
var serialize = require('./serialize.js')
var semver_range = require('./utils.js').semver_range;
var pythreejs = require('jupyter-threejs');

var shaders = {}

shaders["box_fragment"] = require('raw-loader!../glsl/box-fragment.glsl');
shaders["box_vertex"] = require('raw-loader!../glsl/box-vertex.glsl');

var VolumeModel = pythreejs.Object3DModel.extend({
    initialize: function() {
        pythreejs.Object3DModel.prototype.initialize.apply(this, arguments);
        this.initPromise.bind(this).then(this.initialize_volume_model);
    },
    initialize_volume_model: function(){
        this.attributes_changed = {}
        this.data = []

        window.last_volume_view = this;

        var render_size = [400,400]

        if(this.obj.children.length > 0){
            _.each(this.obj.children, child => {
                this.obj.remove(child);
            },this)
        }

        this.vol_box_geo = new THREE.BoxBufferGeometry(1, 1, 1);
        //this.box_material = new THREE.MeshLambertMaterial({color: 0xCC0000});
        this.box_material = new THREE.ShaderMaterial({
            uniforms: {
                offset: { type: '3f', value: [0, 0, 0] },
                scale : { type: '3f', value: [1, 1, 1] },
            },
            fragmentShader: shaders["box_fragment"],
            vertexShader: shaders["box_vertex"],
            side: THREE.BackSide
        });
        this.vol_box_mesh = new THREE.Mesh(this.vol_box_geo, this.box_material)
        //this.vol_box_mesh.position.z = -5;
        this.vol_box_mesh.updateMatrix()
        this.vol_box_mesh.matrixAutoUpdate = true
        this.obj.add(this.vol_box_mesh);

        this.texture_loader = new THREE.TextureLoader()

        this.texture_tf = null;//new THREE.DataTexture(null, this.get("tf").get("rgba").length, 1, THREE.RGBAFormat, THREE.UnsignedByteType)

        this.uniform_volumes_values = {}
        this.uniform_data = {type: 'tv', value: []}
        this.uniform_transfer_function = {type: 'tv', value: []}


        // var update_volr_defines = () => {
        //     if(this.model.get('rendering_method') )
        //     this.box_material_volr.defines = {USE_LIGHTING: this.model.get('rendering_lighting')}
        //     //this.box_material_volr.defines['METHOD_' + this.model.get('rendering_method')] = true;
        //     //this.box_material_volr.defines['VOLUME_COUNT'] = 1
        //     this.box_material_volr.needsUpdate = true
        //     this.box_material_volr_depth.defines = {COORDINATE: true, USE_LIGHTING: this.model.get('rendering_lighting')}
        //     //this.box_material_volr_depth.defines['METHOD_' + this.model.get('rendering_method')] = true;
        //     this.box_material_volr_depth.needsUpdate = true;
        //     //this.box_material_volr_depth.defines['VOLUME_COUNT'] = 1
        // }

        this.tf_set()
        this.data_set()
        var update_rendering_method = () => {
            this.trigger('need_multivolume_material_update');
            this.trigger('need_render');
        }
        this.on('change:rendering_method', update_rendering_method)
        //this.model.on('change:rendering_method change:rendering_lighting', update_volr_defines)
        update_rendering_method()


        this.on('change:data', this.data_set, this);

        var update_minmax = () => {
            this.uniform_volumes_values.data_range = [this.get('data_min'), this.get('data_max')]
            this.uniform_volumes_values.show_range = [this.get('show_min'), this.get('show_max')]
            this.trigger('need_multivolume_material_update');
            this.trigger('need_render');
        }
        this.on('change:data_min change:data_max change:show_min change:show_max', update_minmax, this);
        update_minmax()

        var update_clamp = () => {
            this.uniform_volumes_values.clamp_min = this.get('clamp_min')
            this.uniform_volumes_values.clamp_max = this.get('clamp_max')
            this.trigger('need_multivolume_material_update');
            this.trigger('need_render');
        }
        this.on('change:clamp_min change:clamp_max', update_clamp, this);
        update_clamp()

        var update_opacity_scale = () => {
            this.uniform_volumes_values.opacity_scale = this.get('opacity_scale')
            this.trigger('need_multivolume_material_update');
            this.trigger('need_render');
        }
        update_opacity_scale()
        this.on('change:opacity_scale', update_opacity_scale)

        var update_lighting = () => {
            this.uniform_volumes_values.lighting = this.get('lighting')
            this.trigger('need_multivolume_material_update');
            this.trigger('need_render');
        }
        update_lighting()
        this.on('change:lighting', update_lighting)

        var update_ray_steps = () => {
            this.trigger('need_multivolume_material_update');
            this.trigger('need_render');
        }
        update_ray_steps()
        this.on('change:ray_steps', update_ray_steps)


        var update_brightness = () => {
            this.uniform_volumes_values.brightness = this.get('brightness')
            this.trigger('need_multivolume_material_update');
            this.trigger('need_render');
        }
        update_brightness()
        this.on('change:brightness', update_brightness)

        this.on('change:tf', this.tf_set, this)

        this.on('change:extent', () => {
            this.trigger('need_multivolume_material_update');
            this.trigger('need_render');
        })

        window.last_volume = this; // for debugging purposes

    },
    get_ray_steps: function() {
        var ray_steps = this.get('ray_steps');
        if(ray_steps == null) {
            ray_steps = _.max(this.data_shape)
        }
        return ray_steps;
    },
    is_max_intensity() {
        return this.get('rendering_method') == 'MAX_INTENSITY';
    },
    is_normal() {
        return this.get('rendering_method') == 'NORMAL';
    },
    data_set: function() {
        this.volume = this.get("data")
        if(this.volume != null){ // Sometimes initialization of the object3d model goes to fast and data is not prepared yet.
            var data = new Uint8Array(this.volume.tiles.buffer)
            this.texture_volume = new THREE.DataTexture(data, this.volume.image_shape[0], this.volume.image_shape[1],
                                                        THREE.RGBAFormat, THREE.UnsignedByteType)
            this.texture_volume.magFilter = THREE.LinearFilter
            this.texture_volume.minFilter = THREE.LinearFilter
            this.uniform_volumes_values.rows = this.volume.rows
            this.uniform_volumes_values.columns = this.volume.columns
            this.uniform_volumes_values.slices = this.volume.slices
            this.uniform_volumes_values.size = this.volume.image_shape
            this.uniform_volumes_values.slice_size = this.volume.slice_shape
            this.uniform_data.value = [this.texture_volume]
            this.uniform_data.value = [this.texture_volume]
            this.uniform_volumes_values.data_range = [this.get('data_min'), this.get('data_max')]
            this.uniform_volumes_values.show_range = [this.get('show_min'), this.get('show_max')]
            this.texture_volume.needsUpdate = true // without this it doesn't seem to work
            this.data_shape = [this.volume.slice_shape[0], this.volume.slice_shape[1], this.volume.slices]
            this.trigger('need_multivolume_material_update');
            this.trigger('need_render');
        }
    },
    tf_set: function() {
        // TODO: remove listeners from previous
        if(this.get("tf")) {
            this.get("tf").on('change:rgba', this.tf_changed, this);
            this.tf_changed()
        }
    },
    tf_changed: function() {
        var tf = this.get("tf")
        if(tf) {
            /*if(!this.texture_tf) {
                this.texture_tf = new THREE.DataTexture(tf.get_data_array(), tf.get("rgba").length, 1, THREE.RGBAFormat, THREE.UnsignedByteType)
            } else {
                this.texture_tf.image.data = tf.get_data_array()
                this.texture_tf.needsUpdate = true
            }*/
            this.texture_tf = new THREE.DataTexture(tf.get_data_array(), tf.get("rgba").shape[0], 1, THREE.RGBAFormat, THREE.UnsignedByteType)
            this.texture_tf.needsUpdate = true // without this it doesn't seem to work

            // this.box_material_volr.uniforms.transfer_function.value = [this.texture_tf]
            this.uniform_transfer_function.value = [this.texture_tf]
        }
        this.trigger('need_multivolume_material_update');
        this.trigger('need_render');
    },
    set_limits: function(limits) {
        var xlim = limits.xlim;
        var ylim = limits.ylim
        var zlim = limits.zlim
        var dx = (xlim[1] - xlim[0])
        var dy = (ylim[1] - ylim[0])
        var dz = (zlim[1] - zlim[0])

        var extent = this.get('extent')

       // normalized coordinates of the corners of the box 
        var x0n = (extent[0][0]-xlim[0])/dx
        var x1n = (extent[0][1]-xlim[0])/dx
        var y0n = (extent[1][0]-ylim[0])/dy
        var y1n = (extent[1][1]-ylim[0])/dy
        var z0n = (extent[2][0]-zlim[0])/dz
        var z1n = (extent[2][1]-zlim[0])/dz

        // clipped coordinates
        var cx0 = Math.max(x0n,  0)
        var cx1 = Math.min(x1n,  1)
        var cy0 = Math.max(y0n,  0)
        var cy1 = Math.min(y1n,  1)
        var cz0 = Math.max(z0n,  0)
        var cz1 = Math.min(z1n,  1)

        // the clipped coordinates back to world space, then normalized to extend
        // these are example calculations, the transform goes into scale and offset uniforms below
        // var cwx0 = (cx0 * dx + xlim[0] - extent[0][0])/(extent[0][1] - extent[0][0])
        // var cwx1 = (cx1 * dx + xlim[0] - extent[0][0])/(extent[0][1] - extent[0][0])

        // this.box_geo = new THREE.BoxBufferGeometry(cx1-cx0, cy1-cy0, cz1-cz0)
        // this.box_geo.translate((cx1-x0)/2, (cy1-cy0)/2, (cz1-cz0)/2)
        // this.box_geo.translate(cx0, cy0, cz0)
        // this.box_geo.translate(-0.5, -0.5, -0.5)
        this.box_geo = new THREE.BoxBufferGeometry(1, 1, 1)
        this.box_geo.translate(0.5, 0.5, 0.5)
        this.box_geo.scale((cx1-cx0), (cy1-cy0), (cz1-cz0))
        this.box_geo.translate(cx0, cy0, cz0)
        this.box_geo.translate(-0.5, -0.5, -0.5)
        this.vol_box_mesh.geometry = this.box_geo
        
        this.uniform_volumes_values.scale = [1/(x1n-x0n), 1/(y1n-y0n), 1/(z1n-z0n)]
        this.uniform_volumes_values.offset = [-x0n, -y0n, -z0n]
    },
    defaults: function() {
        return _.extend(pythreejs.Object3DModel.prototype.defaults(), {
            _model_name : 'VolumeModel',
            _model_module : 'ipyvolume',
            _model_module_version: semver_range,
             _view_module_version: semver_range,
            sequence_index: 0,
            step_size: 0.01,
            opacity_scale: 1.0,
            brightness: 1.0,
            extent: null,
            lighting: true,
            rendering_method: 'NORMAL',
            clamp_min: false,
            clamp_max: false,
            data_range: null,
            show_range: null,
            show_min: 0,
            show_max: 1,
            data_min: 0,
            data_max: 1,
            ray_steps: null
        })
    }}, {
    serializers: _.extend({
        tf: { deserialize: widgets.unpack_models },
        data: { serialize: (x) => x}
    }, pythreejs.Object3DModel.serializers)
});

module.exports = {
    VolumeModel:VolumeModel
}
